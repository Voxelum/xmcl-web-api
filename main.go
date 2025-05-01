package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

// MongoDB client for database operations
var mongoClient *mongo.Client
var mongoOnce sync.Once
var mongoDBName string

// BroadcastChannels manages active WebSocket broadcast channels
type BroadcastChannels struct {
	sync.RWMutex
	channels map[string]*BroadcastChannel
}

// BroadcastChannel handles group communication
type BroadcastChannel struct {
	sync.RWMutex
	id        string
	clients   map[string]*websocket.Conn
	messages  chan []byte
	closeSign chan struct{}
}

// Global channels manager
var broadcastChannels = BroadcastChannels{
	channels: make(map[string]*BroadcastChannel),
}

// Translation service models
type TranslationRequest struct {
	Hash        string `json:"hash"`
	Lang        string `json:"lang"`
	Body        string `json:"body"`
	ContentType string `json:"contentType"`
	Type        string `json:"type"`
	ID          string `json:"id"`
}

type TranslationError struct {
	Message string `json:"message"`
}

type TranslationErrorResponse struct {
	Error TranslationError `json:"error"`
}

// RTC API models
type TurnServer struct {
	IP    string `json:"ip"`
	Realm string `json:"realm"`
}

type TurnCredentials struct {
	Username string            `json:"username"`
	Password string            `json:"password"`
	TTL      int               `json:"ttl"`
	URIs     []string          `json:"uris"`
	Meta     map[string]string `json:"meta"`
	Stuns    []string          `json:"stuns,omitempty"`
}

// WebSocket upgrader for group API
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for demo purposes
	},
}

// Gets MongoDB client instance
func getMongoClient() (*mongo.Client, error) {
	var err error
	mongoOnce.Do(func() {
		mongoURI := os.Getenv("MONGO_CONNECION_STRING")
		if mongoURI == "" {
			mongoURI = "mongodb://localhost:27017"
		}
		
		mongoDBName = os.Getenv("MONGODB_NAME")
		if mongoDBName == "" {
			mongoDBName = "xmcl-api"
		}
		
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		
		client, e := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI))
		if e != nil {
			err = fmt.Errorf("failed to connect to MongoDB: %v", e)
			return
		}
		
		// Ping to verify connection
		if e = client.Ping(ctx, readpref.Primary()); e != nil {
			err = fmt.Errorf("failed to ping MongoDB: %v", e)
			return
		}
		
		mongoClient = client
	})
	
	return mongoClient, err
}

// GetMongoDB returns the MongoDB database
func GetMongoDB() (*mongo.Database, error) {
	client, err := getMongoClient()
	if err != nil {
		return nil, err
	}
	return client.Database(mongoDBName), nil
}

// Create a new broadcast channel
func NewBroadcastChannel(id string) *BroadcastChannel {
	channel := &BroadcastChannel{
		id:        id,
		clients:   make(map[string]*websocket.Conn),
		messages:  make(chan []byte, 256),
		closeSign: make(chan struct{}),
	}
	
	go channel.run()
	return channel
}

// Run the broadcast channel
func (bc *BroadcastChannel) run() {
	for {
		select {
		case message := <-bc.messages:
			bc.RLock()
			for _, client := range bc.clients {
				if err := client.WriteMessage(websocket.BinaryMessage, message); err != nil {
					fmt.Printf("Error sending message to client: %v\n", err)
				}
			}
			bc.RUnlock()
		case <-bc.closeSign:
			return
		}
	}
}

// Add a client to the broadcast channel
func (bc *BroadcastChannel) AddClient(id string, conn *websocket.Conn) {
	bc.Lock()
	defer bc.Unlock()
	bc.clients[id] = conn
	fmt.Printf("[%s] [%s] Client added to channel\n", bc.id, id)
}

// Remove a client from the broadcast channel
func (bc *BroadcastChannel) RemoveClient(id string) {
	bc.Lock()
	defer bc.Unlock()
	delete(bc.clients, id)
	fmt.Printf("[%s] [%s] Client removed from channel\n", bc.id, id)
	
	// Close channel if no clients left
	if len(bc.clients) == 0 {
		close(bc.closeSign)
		broadcastChannels.Lock()
		delete(broadcastChannels.channels, bc.id)
		broadcastChannels.Unlock()
		fmt.Printf("[%s] Channel closed (no clients)\n", bc.id)
	}
}

// Post a message to all clients in the channel
func (bc *BroadcastChannel) PostMessage(msg []byte) {
	select {
	case bc.messages <- msg:
	default:
		fmt.Printf("[%s] Message buffer full, message dropped\n", bc.id)
	}
}

// Get the broadcast channel for a group, creating if needed
func GetBroadcastChannel(id string) *BroadcastChannel {
	broadcastChannels.RLock()
	channel, exists := broadcastChannels.channels[id]
	broadcastChannels.RUnlock()
	
	if !exists {
		broadcastChannels.Lock()
		// Check again in case another goroutine created it
		channel, exists = broadcastChannels.channels[id]
		if !exists {
			channel = NewBroadcastChannel(id)
			broadcastChannels.channels[id] = channel
		}
		broadcastChannels.Unlock()
	}
	
	return channel
}

// Get a unique client ID based on WebSocket binary data
func getClientID(data []byte) string {
	if len(data) < 16 {
		return ""
	}
	
	id := ""
	for i := 0; i < 16; i++ {
		id += fmt.Sprintf("%02x", data[i])
	}
	
	// Format as UUID
	return fmt.Sprintf("%s-%s-%s-%s-%s", 
		id[0:8], id[8:12], id[12:16], id[16:20], id[20:32])
}

// Group API implementation
func handleGroup(c *gin.Context) {
	groupID := c.Param("id")
	
	// Upgrade HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to upgrade connection"})
		return
	}
	
	// Get the broadcast channel for this group
	channel := GetBroadcastChannel(groupID)
	
	// Get client ID from URL parameter or generate one later
	clientID := c.Query("client")
	if clientID != "" {
		fmt.Printf("[%s] [%s] Get join group request!\n", groupID, clientID)
	} else {
		fmt.Printf("[%s] [unknown] Get join group request!\n", groupID)
	}
	
	// Handle WebSocket connection
	go handleWebSocketConnection(conn, channel, groupID, clientID)
}

// Handle WebSocket connection for group API
func handleWebSocketConnection(conn *websocket.Conn, channel *BroadcastChannel, groupID, clientID string) {
	defer conn.Close()
	fmt.Printf("[%s] Websocket created!\n", groupID)
	
	// Register client if we have an ID already
	if clientID != "" {
		channel.AddClient(clientID, conn)
	}
	
	// Handle incoming WebSocket messages
	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				fmt.Printf("[%s] [%s] Websocket error: %v\n", groupID, clientID, err)
			}
			break
		}
		
		if messageType == websocket.TextMessage && len(message) > 0 {
			// Handle text message (JSON)
			var data map[string]interface{}
			if err := json.Unmarshal(message, &data); err == nil {
				if sender, ok := data["sender"].(string); ok && clientID == "" {
					clientID = sender
					channel.AddClient(clientID, conn)
					fmt.Printf("[%s] [%s] Set client id\n", groupID, clientID)
				}
				
				receiver, receiverExists := data["receiver"].(string)
				msgType, _ := data["type"].(string)
				sender, _ := data["sender"].(string)
				
				if clientID != "" && receiverExists {
					fmt.Printf("[%s] [%s] Broadcast %s from client. %s -> %s\n", 
						groupID, clientID, msgType, sender, receiver)
				}
				
				// Broadcast message to all clients in the channel
				channel.PostMessage(message)
			}
		} else if messageType == websocket.BinaryMessage {
			// Handle binary message
			if clientID == "" && len(message) >= 16 {
				// Extract client ID from binary data
				clientID = getClientID(message)
				channel.AddClient(clientID, conn)
				fmt.Printf("[%s] [%s] Set client id from binary\n", groupID, clientID)
			}
			
			// Check if message contains ping data (timestamp after 16 bytes)
			if len(message) > 16 {
				// Extract timestamp from the message (bytes 16-24)
				timestamp := extractTimestampFromBinary(message)
				
				// Send PONG response
				response := map[string]interface{}{
					"type":      "PONG",
					"timestamp": timestamp,
				}
				respData, _ := json.Marshal(response)
				conn.WriteMessage(websocket.TextMessage, respData)
				
				// Only broadcast the first 16 bytes (client ID)
				channel.PostMessage(message[:16])
			} else {
				// Broadcast full binary message
				channel.PostMessage(message)
			}
		}
	}
	
	// Clean up when connection closes
	if clientID != "" {
		channel.RemoveClient(clientID)
	}
}

// Extract timestamp from binary data
func extractTimestampFromBinary(data []byte) float64 {
	if len(data) < 24 {
		return 0
	}
	
	// Assuming timestamp is stored as a float64 at offset 16
	bits := uint64(data[16]) | uint64(data[17])<<8 | uint64(data[18])<<16 | uint64(data[19])<<24 |
		uint64(data[20])<<32 | uint64(data[21])<<40 | uint64(data[22])<<48 | uint64(data[23])<<56
	return float64frombits(bits)
}

// Convert bits to float64
func float64frombits(bits uint64) float64 {
	return float64(*(*float64)(unsafe.Pointer(&bits)))
}

// Translation API implementation
func handleTranslation(c *gin.Context) {
	// Check required parameters
	typeParam := c.Query("type")
	if typeParam == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No type specified"})
		return
	}
	
	if typeParam != "modrinth" && typeParam != "curseforge" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid type"})
		return
	}
	
	id := c.Query("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No id specified"})
		return
	}
	
	// Get preferred language
	langs := c.GetHeader("Accept-Language")
	if langs == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No language specified"})
		return
	}
	
	lang := strings.Split(langs, ",")[0]
	if lang == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No language specified"})
		return
	}
	
	// Return empty response for English requests
	if lang == "*" || strings.HasPrefix(lang, "en") {
		c.Status(http.StatusNoContent)
		return
	}
	
	// Fetch content based on type
	var body string
	var contentType string
	var err error
	
	if typeParam == "curseforge" {
		body, err = getCurseforgeDescription(c, id)
		contentType = "text/html"
	} else {
		body, err = getModrinthDescription(c, id)
		contentType = "text/markdown"
	}
	
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	
	// Generate hash for cache lookup
	hash := generateHash(body + lang)
	
	// Check if translation already exists in database
	db, err := GetMongoDB()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to connect to database"})
		return
	}
	
	coll := db.Collection("translated")
	var result struct {
		Content string `bson:"content"`
	}
	
	err = coll.FindOne(context.Background(), bson.M{"_id": hash}).Decode(&result)
	if err == nil {
		// Found cached translation
		c.Header("Content-Language", lang)
		c.Header("Content-Type", contentType)
		c.Header("Cache-Control", "public, max-age=86400")
		c.String(http.StatusOK, result.Content)
		return
	}
	
	// No cached translation, enqueue or translate immediately
	// For simplicity in this implementation, we'll translate immediately
	// In a production environment, you would implement a queue system
	
	translatedText, err := translateContent(lang, body, contentType)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	
	// Store translation in database
	_, err = coll.InsertOne(context.Background(), bson.M{
		"_id":         hash,
		"id":          id,
		"content":     translatedText,
		"locale":      lang,
		"contentType": contentType,
		"type":        typeParam,
	})
	
	if err != nil {
		fmt.Printf("Failed to store translation: %v\n", err)
	}
	
	c.Header("Content-Language", lang)
	c.Header("Content-Type", contentType)
	c.Header("Cache-Control", "public, max-age=86400")
	c.String(http.StatusOK, translatedText)
}

// Get Curseforge mod description
func getCurseforgeDescription(c *gin.Context, id string) (string, error) {
	url := fmt.Sprintf("https://api.curseforge.com/v1/mods/%s/description", id)
	
	// Create request with headers
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	
	// Copy headers from client request
	for name, values := range c.Request.Header {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	
	// Add Curseforge API key
	cfKey := os.Getenv("CURSEFORGE_KEY")
	if cfKey != "" {
		req.Header.Set("x-api-key", cfKey)
	}
	
	// Send request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("curseforge API error: %s", string(bodyBytes))
	}
	
	// Parse response
	var result struct {
		Data string `json:"data"`
	}
	
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	
	return result.Data, nil
}

// Get Modrinth project description
func getModrinthDescription(c *gin.Context, id string) (string, error) {
	url := fmt.Sprintf("https://api.modrinth.com/v2/project/%s", id)
	
	// Create request with headers
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return "", err
	}
	
	// Copy headers from client request
	for name, values := range c.Request.Header {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	
	// Send request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("modrinth API error: %s", string(bodyBytes))
	}
	
	// Parse response
	var result struct {
		Body string `json:"body"`
	}
	
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	
	return result.Body, nil
}

// Generate hash for content
func generateHash(content string) string {
	// Simple hash implementation for demo purposes
	// In production, use a proper hashing algorithm
	h := sha1.New()
	h.Write([]byte(content))
	return fmt.Sprintf("%x", h.Sum(nil))
}

// Translate content using external service
func translateContent(lang, body, contentType string) (string, error) {
	// In a production environment, you would implement a proper translation service
	// This is a placeholder implementation
	fmt.Printf("Translating content to %s, content type: %s\n", lang, contentType)
	
	// Call your translation service here
	// For demo purposes, we'll return the original content
	return body, nil
}

// RTC API implementation
func handleRtcOfficial(c *gin.Context) {
	// Parse STUN servers
	stuns := []string{
		"stun.miwifi.com:3478",
		"stun.l.google.com:19302",
		"stun2.l.google.com:19302", 
		"stun3.l.google.com:19302",
		"stun4.l.google.com:19302", 
		"stun.voipbuster.com:3478",
		"stun.voipstunt.com:3478",
		"stun.internetcalls.com:3478",
		"stun.voip.aebc.com:3478",
		"stun.qq.com:3478",
	}
	
	// Get RTC_SECRET from environment
	secret := os.Getenv("RTC_SECRET")
	
	// Parse TURN servers from environment
	turns := parseTurnsFromEnv()
	
	// Build response
	if secret != "" {
		// Get user profile - would come from auth middleware
		// For simplicity, we'll use a mock profile
		userID := "demo-user-id"
		
		// Ensure the user account exists in the database
		err := ensureRtcAccount(userID, "official")
		if err != nil {
			fmt.Printf("Failed to ensure RTC account: %v\n", err)
		}
		
		// Generate TURN credentials
		creds := getTURNCredentials(userID, secret, turns)
		creds.Stuns = stuns
		
		c.JSON(http.StatusOK, creds)
	} else {
		// No secret, return only STUN servers
		c.JSON(http.StatusOK, gin.H{
			"stuns": stuns,
			"uris":  []string{},
		})
	}
}

// Parse TURN servers from environment
func parseTurnsFromEnv() []TurnServer {
	turnsEnv := os.Getenv("TURNS")
	if turnsEnv == "" {
		return nil
	}
	
	var turns []TurnServer
	pairs := strings.Split(turnsEnv, ",")
	
	for _, pair := range pairs {
		parts := strings.Split(pair, ":")
		if len(parts) == 2 {
			turns = append(turns, TurnServer{
				Realm: parts[0],
				IP:    parts[1],
			})
		}
	}
	
	return turns
}

// Ensure RTC account exists in database
func ensureRtcAccount(name, namespace string) error {
	db, err := GetMongoDB()
	if err != nil {
		return err
	}
	
	collection := db.Collection("turnusers_lt")
	
	// Update or insert user
	_, err = collection.UpdateOne(
		context.Background(),
		bson.M{
			"name":  fmt.Sprintf("%s:%s", namespace, name),
			"realm": "xmcl",
		},
		bson.M{
			"$set": bson.M{
				"name":    fmt.Sprintf("%s:%s", namespace, name),
				"realm":   "xmcl",
				"hmackey": "5eb36f16f3bca1acf48639d9919c5094",
			},
		},
		options.Update().SetUpsert(true),
	)
	
	return err
}

// Generate TURN credentials
func getTURNCredentials(name, secret string, turns []TurnServer) TurnCredentials {
	// Generate expiration timestamp (24 hours from now)
	expiry := time.Now().Unix() + 24*3600
	
	// Create username with expiration timestamp
	username := fmt.Sprintf("%d:%s", expiry, name)
	
	// Calculate HMAC-SHA1 for the password
	h := hmac.New(sha1.New, []byte(secret))
	h.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(h.Sum(nil))
	
	// Build URIs and metadata
	uris := []string{
		"turn:20.239.69.131",
		"turn:20.199.15.21", 
		"turn:20.215.243.212",
	}
	
	meta := map[string]string{
		"20.239.69.131":  "hk",
		"20.199.15.21":   "fr", 
		"20.215.243.212": "po",
	}
	
	// Add custom TURN servers
	for _, turn := range turns {
		uris = append(uris, fmt.Sprintf("turn:%s", turn.IP))
		meta[turn.IP] = turn.Realm
	}
	
	return TurnCredentials{
		Username: username,
		Password: password,
		TTL:      86400,
		URIs:     uris,
		Meta:     meta,
	}
}

func main() {
	// Get port from environment or use default
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080" // Different port from azure.go
	}
	
	// Create router
	router := gin.Default()
	
	// Configure CORS
	router.Use(cors.Default())
	
	// API routes
	router.GET("/group/:id", handleGroup)
	router.GET("/translation", handleTranslation)
	router.POST("/rtc/official", handleRtcOfficial)
	
	// Default route
	router.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"endpoints": []string{
				"/group/:id",
				"/translation",
				"/rtc/official",
			},
		})
	})
	
	// Start server
	fmt.Printf("Server starting on port %s\n", port)
	router.Run(":" + port)
}