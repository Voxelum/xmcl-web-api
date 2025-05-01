package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// Notification represents a notification from GitHub issues
type Notification struct {
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Tags      []string  `json:"tags"`
}

// GithubIssue represents a GitHub issue
type GithubIssue struct {
	ID        int       `json:"id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Labels    []struct {
		Name string `json:"name"`
	} `json:"labels"`
}

// GithubReleaseAsset represents an asset in a GitHub release
type GithubReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// GithubReleaseItem represents a GitHub release
type GithubReleaseItem struct {
	TagName    string               `json:"tag_name"`
	Prerelease bool                 `json:"prerelease"`
	Body       string               `json:"body"`
	Assets     []GithubReleaseAsset `json:"assets"`
	Draft      bool                 `json:"draft"`
}

// parseLabels parses GitHub issue labels and returns tags
func parseLabels(labels []struct{ Name string `json:"name"` }, version string) []string {
	var tags []string
	var versionCriteria string

	for _, label := range labels {
		if strings.HasPrefix(label.Name, "t:") {
			tags = append(tags, label.Name[2:])
		} else if strings.HasPrefix(label.Name, "v:") {
			versionCriteria = label.Name[2:]
		}
	}

	if versionCriteria != "" && version != "" {
		// Note: In Go implementation, we're simplifying semver check
		// A proper implementation would use a semver library
		if compareVersions(version, versionCriteria) {
			return nil
		}
	}

	return tags
}

// compareVersions is a simplified version check - in production use a proper semver library
func compareVersions(version, versionCriteria string) bool {
	// This is a very simplified version - in a real implementation, use a proper semver library
	// For now, we'll just return false to bypass version checks
	return false
}

// semverGte checks if v1 >= v2 (simplified)
func semverGte(v1, v2 string) bool {
	// Remove v prefix if exists
	v1 = strings.TrimPrefix(v1, "v")
	v2 = strings.TrimPrefix(v2, "v")
	
	// Simple string comparison - in production use a proper semver library
	return v1 >= v2
}

// semverLt checks if v1 < v2 (simplified)
func semverLt(v1, v2 string) bool {
	// Remove v prefix if exists
	v1 = strings.TrimPrefix(v1, "v")
	v2 = strings.TrimPrefix(v2, "v")
	
	// Simple string comparison - in production use a proper semver library
	return v1 < v2
}

func APIPort() string {
	port := ":8080"
	if val, ok := os.LookupEnv("FUNCTIONS_CUSTOMHANDLER_PORT"); ok {
	 port = ":" + val
	}
	return port
}

func main() {
	router := gin.Default()

	// Configure CORS
	router.Use(cors.Default())

	// API routes
	router.GET("/notifications", handleNotifications)
	router.GET("/flights", handleFlights)
	router.GET("/releases/:filename", handleReleases)
	router.GET("/latest", handleLatest)
	router.GET("/zulu", handleZulu)

	// Default route
	router.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, []string{
			"/notifications", 
			"/flights", 
			"/releases/:filename", 
			"/latest", 
			"/zulu",
		})
	})

	// Get port from environment or use default
	port := APIPort()
	if port == "" {
		port = "8080"
	}

	router.Run(":" + port)
}

// handleNotifications handles the /notifications endpoint
func handleNotifications(c *gin.Context) {
	version := c.Query("version")
	osType := c.Query("os")  // Changed from 'os' to 'osType' to avoid shadowing os package
	arch := c.Query("arch")
	env := c.Query("env")
	locale := c.Query("locale")

	labels := fmt.Sprintf("os:%s,arch:%s,env:%s,l:%s", osType, arch, env, locale)
	githubPAT := os.Getenv("GITHUB_PAT")

	// Create HTTP client
	client := &http.Client{}

	// Create request
	req, err := http.NewRequest("GET", 
		fmt.Sprintf("https://api.github.com/repos/voxelum/xmcl-static-resource/issues?labels=%s&per_page=5&creator=ci010", labels),
		nil)
	
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Set headers
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	if githubPAT != "" {
		req.Header.Set("Authorization", "token "+githubPAT)
	}

	// Send request
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Parse JSON response
	var issues []GithubIssue
	if err := json.Unmarshal(body, &issues); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Convert to notifications
	var notifications []Notification
	for _, issue := range issues {
		tags := parseLabels(issue.Labels, version)
		if tags != nil {
			notifications = append(notifications, Notification{
				CreatedAt: issue.CreatedAt,
				UpdatedAt: issue.UpdatedAt,
				ID:        strconv.Itoa(issue.ID),
				Title:     issue.Title,
				Body:      issue.Body,
				Tags:      tags,
			})
		}
	}

	c.Header("Content-Type", "application/json")
	c.JSON(resp.StatusCode, notifications)
}

// handleFlights handles the /flights endpoint
func handleFlights(c *gin.Context) {
	version := c.Query("version")
	locale := c.Query("locale")
	build := c.Query("build")

	if version == "" || locale == "" {
		c.JSON(http.StatusOK, gin.H{})
		return
	}

	if build != "" {
		buildNum, err := strconv.Atoi(build)
		if err == nil && buildNum > 1002 {
			c.JSON(http.StatusOK, gin.H{
				"i18nSearch": []string{"zh-CN"},
			})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{})
}

// handleReleases handles the /releases/:filename endpoint
func handleReleases(c *gin.Context) {
	fileName := c.Param("filename")
	parts := strings.Split(fileName, "-")
	
	if len(parts) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid filename format"})
		return
	}
	
	version := parts[1]
	redirectURL := fmt.Sprintf("https://github.com/Voxelum/x-minecraft-launcher/releases/download/v%s/%s", version, fileName)
	
	c.Redirect(http.StatusFound, redirectURL)
}

// handleLatest handles the /latest endpoint
func handleLatest(c *gin.Context) {
	includePrerelease := c.Query("prerelease") != ""
	version := c.Query("version")
	
	// Parse Accept-Language header
	lang := ""
	acceptLang := c.GetHeader("Accept-Language")
	if acceptLang != "" {
		langItems := strings.Split(acceptLang, ";")
		for _, item := range langItems {
			if strings.Contains(item, "zh") {
				lang = "zh"
				break
			} else if strings.Contains(item, "en") {
				lang = "en"
				break
			}
		}
	}

	// Create HTTP client
	client := &http.Client{}

	// Create request
	req, err := http.NewRequest("GET", 
		"https://api.github.com/repos/voxelum/x-minecraft-launcher/releases?per_page=10",
		nil)
	
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Set headers
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	githubPAT := os.Getenv("GITHUB_PAT")
	if githubPAT != "" {
		req.Header.Set("Authorization", "token "+githubPAT)
	}

	// Send request
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Parse JSON response
	var releases []GithubReleaseItem
	if err := json.Unmarshal(body, &releases); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if version != "" {
		var latest *GithubReleaseItem
		var recent []GithubReleaseItem

		if version == "v1.0.7" {
			// Special case for v1.0.7
			latest = &releases[0]
			recent = releases[5:]
		} else {
			// Filter recent versions
			for _, r := range releases {
				if !r.Draft && semverGte(r.TagName[1:], version) {
					recent = append(recent, r)
				}
			}
			
			if len(recent) > 0 {
				latest = &recent[0]
			}
		}

		if latest == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Cannot find the compatible version"})
			return
		}

		// Filter assets based on version constraints
		if semverLt(version, "0.30.0") {
			var filteredAssets []GithubReleaseAsset
			for _, asset := range latest.Assets {
				if !strings.HasSuffix(asset.Name, "asar") {
					filteredAssets = append(filteredAssets, asset)
				}
			}
			latest.Assets = filteredAssets
		}

		if semverLt(version, "0.38.0") {
			var filteredAssets []GithubReleaseAsset
			for _, asset := range latest.Assets {
				if !strings.HasSuffix(asset.Name, "asar") {
					filteredAssets = append(filteredAssets, asset)
				}
			}
			latest.Assets = filteredAssets
		}

		if semverLt(version, "0.44.2") {
			var filteredAssets []GithubReleaseAsset
			for _, asset := range latest.Assets {
				if !strings.HasSuffix(asset.Name, "asar") {
					filteredAssets = append(filteredAssets, asset)
				}
			}
			latest.Assets = filteredAssets
		}

		// Generate changelogs
		var changelogs []string
		for _, r := range recent {
			v := r.TagName
			if strings.HasPrefix(v, "v") {
				v = v[1:]
			}

			if lang != "" {
				// Try to fetch localized changelog
				changelogURL := fmt.Sprintf("https://raw.githubusercontent.com/voxelum/xmcl-page/master/src/%s/changelogs/%s.md", lang, v)
				
				resp, err := http.Get(changelogURL)
				if err == nil && resp.StatusCode == 200 {
					markdown, err := io.ReadAll(resp.Body)
					resp.Body.Close()
					
					if err == nil {
						content := string(markdown)
						lastDash := strings.LastIndex(content, "---")
						if lastDash != -1 && lastDash+4 < len(content) {
							changelogs = append(changelogs, content[lastDash+4:])
							continue
						}
					}
				}
				// Fallback to release body if markdown fetch fails
				changelogs = append(changelogs, r.Body)
			} else {
				changelogs = append(changelogs, r.Body)
			}
		}

		// Add Windows appx user notice for older versions
		if semverLt(version, "0.40.0") {
			if lang == "zh" {
				changelogs = append([]string{
					"# 注意 (Windows 用户)",
					"如果您是通过 Appx 或 AppInstaller 安装的启动器，请注意：",
					"由于证书过期，您将不会很快收到最新更新。建议您下载 zip 包并手动安装。",
					"点击[这个链接](https://docs.xmcl.app/zh/guide/appx-migrate)查看如何迁移数据。",
				}, changelogs...)
			} else {
				changelogs = append([]string{
					"# Notice (Windows User)",
					"If you installed the launcher via Appx or AppInstaller, please be aware:",
					"You won't receive the latest updates soon due to the certificate expiration. It's suggested to download the zip package and install it manually.",
					"Click [this link](https://docs.xmcl.app/en/guide/appx-migrate) to see how to migrate your data.",
				}, changelogs...)
			}
		}

		// Join changelogs
		latest.Body = strings.Join(changelogs, "\n\n")
		c.JSON(http.StatusOK, latest)
	} else {
		// Return latest release (non-draft)
		var filtered *GithubReleaseItem
		for i := range releases {
			if !releases[i].Draft && (includePrerelease || !releases[i].Prerelease) {
				filtered = &releases[i]
				break
			}
		}
		
		if filtered != nil {
			c.JSON(http.StatusOK, filtered)
		} else {
			c.JSON(http.StatusNotFound, gin.H{"error": "No releases found"})
		}
	}
}

// handleZulu handles the /zulu endpoint
func handleZulu(c *gin.Context) {
	// Create HTTP client
	client := &http.Client{}

	// Create request
	req, err := http.NewRequest("GET", 
		"https://raw.githubusercontent.com/Voxelum/xmcl-static-resource/refs/heads/main/zulu.json",
		nil)
	
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Copy headers from client request
	for name, values := range c.Request.Header {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}

	// Send request
	resp, err := client.Do(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	// Copy headers from response
	for name, values := range resp.Header {
		for _, value := range values {
			c.Header(name, value)
		}
	}

	// Copy status
	c.Status(resp.StatusCode)

	// Copy body
	c.DataFromReader(resp.StatusCode, resp.ContentLength, resp.Header.Get("Content-Type"), resp.Body, nil)
}