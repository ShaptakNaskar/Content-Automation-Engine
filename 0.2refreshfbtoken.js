const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

dotenv.config();

const {
  FB_APPID,
  FB_APPSECRET,
  FB_USER_ACCESS_TOKEN,
  PAGE_ID,
  PAGE_TOKEN
} = process.env;

if (!FB_APPID || !FB_APPSECRET || !FB_USER_ACCESS_TOKEN || !PAGE_ID) {
  console.error('Missing required env values.');
  process.exit(1);
}

const ENV_PATH = path.resolve(process.cwd(), '.env');
const APP_TOKEN = `${FB_APPID}|${FB_APPSECRET}`;

/* =========================
   VALIDATE EXISTING PAGE TOKEN
========================= */
async function isPageTokenValid() {
  if (!PAGE_TOKEN) return false;

  try {
    console.log('Checking existing PAGE_TOKEN validity...');

    const res = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${PAGE_TOKEN}&access_token=${APP_TOKEN}`
    );

    const data = await res.json();
    return data?.data?.is_valid === true;
  } catch {
    return false;
  }
}

/* =========================
    REFRESH PAGE TOKEN
========================= */
async function refreshPageToken() {
  try {
    console.log('Exchanging USER token for long-lived token...');

    const longUserRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${FB_APPID}` +
      `&client_secret=${FB_APPSECRET}` +
      `&fb_exchange_token=${FB_USER_ACCESS_TOKEN}`
    );

    const longUserData = await longUserRes.json();

    if (!longUserData.access_token) {
      const fbError = longUserData?.error;

      if (fbError?.code === 190 && fbError?.error_subcode === 463) {
        console.error('\nUSER ACCESS TOKEN HAS EXPIRED');
        console.error('This token is permanently dead.');
        console.error('Fix: Generate a NEW token from Facebook Graph Explorer.');
        console.error('Then update FB_USER_ACCESS_TOKEN in your .env file.\n');
      } else {
        console.error('Failed to get long-lived USER token:', longUserData);
      }

      process.exit(1);
    }

    const longUserToken = longUserData.access_token;
    console.log('Long-lived USER token obtained.');

    console.log('Fetching Page token...');

    const pageRes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${longUserToken}`
    );

    const pageData = await pageRes.json();
    const page = pageData?.data?.find(p => p.id === PAGE_ID);

    if (!page?.access_token) {
      console.error('Page not found or no Page token returned.');
      process.exit(1);
    }

    const newPageToken = page.access_token;
    console.log('New long-lived PAGE token obtained.');

    let envFile = fs.readFileSync(ENV_PATH, 'utf8');

    if (envFile.includes('PAGE_TOKEN=')) {
      envFile = envFile.replace(
        /^PAGE_TOKEN=.*$/m,
        `PAGE_TOKEN=${newPageToken}`
      );
    } else {
      envFile += `\nPAGE_TOKEN=${newPageToken}`;
    }

    fs.writeFileSync(ENV_PATH, envFile);
    console.log('.env file updated with new PAGE_TOKEN.');

  } catch (err) {
    console.error('Token refresh failed:', err.message);
    process.exit(1);
  }
}

/* =========================
   MAIN EXECUTION
========================= */
(async () => {
  const isValid = await isPageTokenValid();

  if (isValid) {
    console.log('Existing PAGE_TOKEN is still valid. No refresh needed.');
    process.exit(0);
  }

  console.log('PAGE_TOKEN invalid or missing. Refreshing...');
  await refreshPageToken();
})();
