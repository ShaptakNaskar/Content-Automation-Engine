/**
 * 0.oauth.js - Fully Automatic Google OAuth Setup (Windows Safe)
 * - Auto-opens browser
 * - Auto-captures auth code
 * - Auto-refreshes token
 * - Saves token.json
 */

const fs = require('fs').promises;
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

// ===== CONFIG =====

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

// ==================


// ✅ SAFE BROWSER OPENER (ESM-compatible)
async function openBrowser(url) {
  const mod = await import('open');
  return mod.default(url);
}

async function loadCredentials() {
  try {
    const content = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`credentials.json not found: ${err.message}`);
  }
}

async function loadOrRefreshToken() {
  try {
    const token = await fs.readFile(TOKEN_PATH, 'utf8');
    return JSON.parse(token);
  } catch {
    return null;
  }
}

async function saveToken(token) {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log('token.json saved');
}

async function authenticate() {
  const credentials = await loadCredentials();
  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;

  const redirectUri = redirect_uris[0];

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirectUri
  );

  // ===== TRY EXISTING TOKEN =====
  let token = await loadOrRefreshToken();

  if (token) {
    oauth2Client.setCredentials(token);

    if (token.expiry_date && token.expiry_date <= Date.now()) {
      console.log('Token expired, refreshing...');

      try {
        const { credentials } =
          await oauth2Client.refreshAccessToken();

        token = credentials;
        oauth2Client.setCredentials(token);
        await saveToken(token);
        console.log('Token refreshed');
      } catch {
        console.error('Token refresh failed, re-auth required');
        token = null;
      }
    }
  }

  if (token) return oauth2Client;

  // ===== NEW AUTH FLOW =====
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('Opening browser for authentication...');
  await openBrowser(authUrl);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.includes('code=')) return;

      const fullUrl = new URL(req.url, redirectUri);
      const code = fullUrl.searchParams.get('code');

      res.end('Authentication flow has completed. You may now close the tab. Or stay. I don't care');
      server.close();

      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        await saveToken(tokens);
        console.log('Authentication successful');
        resolve(oauth2Client);
      } catch (err) {
        reject(err);
      }
    });

    //  WINDOWS-SAFE PORT
    server.listen(80, () => {
      console.log('Waiting for Google OAuth callback on http://localhost:80');
    });
  });
}

// ===== TEST RUNNER =====

async function main() {
  try {
    await authenticate();
    console.log('OAuth ready for API calls');
  } catch (err) {
    console.error('OAuth failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  authenticate,
  loadOrRefreshToken,
  saveToken,
};
