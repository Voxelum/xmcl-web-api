export interface MicrosoftProfile {
  id: string;
  userPrincipalName: string;
}

export async function checkMicrosoftAuthenticate(authorization: string) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: {
      Authorization: authorization,
    },
  });
  if (response.status === 200) {
    const content = await response.json();
    const { id, userPrincipalName } = content;
    return {
      id: id as string,
      userPrincipalName: userPrincipalName as string,
    } as MicrosoftProfile;
  }
  throw ({
    statusCode: response.status,
    error: "Fail to request microsoft graph to verify user!",
  });
}
