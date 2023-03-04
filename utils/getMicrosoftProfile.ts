export interface MicrosoftMinecraftProfile {
  id: string;
  name: string;
}

export async function getMicrosoftMinecraftProfile(token: string) {
  const response = await fetch(
    "https://api.minecraftservices.com/minecraft/profile",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (response.status !== 200) {
    throw { status: response.status };
  }
  return await response.json() as MicrosoftMinecraftProfile;
}
