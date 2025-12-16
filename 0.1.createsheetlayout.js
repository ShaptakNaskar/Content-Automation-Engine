/**
 * 0.1.createsheetlayout.js - Initialize Google Sheet with headers
 * Run once to set up the sheet structure
 */

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs').promises;

const HEADERS = [
  'Company',
  'Website',
  'Topic',
  'Caption',
  'Hashtags',
  'ImagePrompt',
  'GenImage',
  'GenComplete',
  'EmbedLogo(yes/no)',
  'LogoUrl',
  'LogoPosition',
  'LogoEmbedComplete',
  'ImageWithLogoEmbedded',
  'EmbedText(yes/no)',
  'TextContent',
  'TextPosition',
  'TextFont',
  'TextColor',
  'TextBackground',
  'TextEmbedComplete',
  'ImageWithTextEmbedded',
  'NewImageLink',
  'GenPipeComplete(yes/no)',
  'Post(yes/no)',
  'PostDate(DD/MM/YY)',
  'PostTime(HH:MM AM/PM)',
  'PostStatus',
  'AllProcessComplete'
];


function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) throw new Error('❌ Invalid Google Sheet link.');
  return match[1];
}

async function authenticate() {
  try {
    const tokenData = await fs.readFile(path.join(__dirname, 'token.json'), 'utf8');
    const token = JSON.parse(tokenData);

    const credData = await fs.readFile(path.join(__dirname, 'credentials.json'), 'utf8');
    const credentials = JSON.parse(credData);

    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    oauth2Client.setCredentials(token);
    return oauth2Client;
  } catch (err) {
    throw new Error(`Auth failed: ${err.message}`);
  }
}

async function setHeaders(auth, sheetId) {
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    requestBody: {
      values: [HEADERS]
    }
  });

  console.log('Headers created successfully.');
}

async function main() {
  try {
    const sheetUrl = process.env.SHEET_URL;
    if (!sheetUrl) throw new Error('SHEET_URL not set in .env');

    const sheetId = extractSheetId(sheetUrl);
    console.log('Sheet ID:', sheetId);

    const auth = await authenticate();
    await setHeaders(auth, sheetId);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { setHeaders };