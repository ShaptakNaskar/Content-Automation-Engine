const fs = require('fs');
const path = require('path');
const https = require('https');
const { google } = require('googleapis');
require('dotenv').config();
const { createCanvas, loadImage, registerFont } = require('canvas');
const stream = require('stream');
const { promisify } = require('util');

const pipeline = promisify(stream.pipeline);

// --- 1. Authentication ---
console.log('Loading client credentials from credentials.json...');
let auth;
try {
  const credentialsPath = 'credentials.json';
  if (!fs.existsSync(credentialsPath)) {
    throw new Error('credentials.json not found. Please download it from Google Cloud Console.');
  }
  const credentialsContent = fs.readFileSync(credentialsPath, 'utf8');
  const credentials = JSON.parse(credentialsContent);
  const creds = credentials.installed || credentials.web;
  auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris[0]
  );
  console.log('Client credentials loaded successfully.\n');

  const tokenPath = 'token.json';
  if (fs.existsSync(tokenPath)) {
    const tokenContent = fs.readFileSync(tokenPath, 'utf8');
    auth.setCredentials(JSON.parse(tokenContent));
    console.log('Authentication token loaded successfully.\n');
  } else {
    throw new Error('token.json not found. Please run the authorization script first.');
  }
} catch (error) {
  console.error('Error loading authentication:', error.message);
  process.exit(1);
}

const sheets = google.sheets({ version: 'v4', auth });
const drive = google.drive({ version: 'v3', auth });

const SHEET_URL = process.env.SHEET_URL;
if (!SHEET_URL) {
  console.error('SHEET_URL not found in .env file.');
  process.exit(1);
}
console.log('SHEET_URL loaded from .env.\n');

console.log('Parsing spreadsheet ID from URL...');
const spreadsheetIdMatch = SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/);
if (!spreadsheetIdMatch) {
  console.error('Invalid SHEET_URL format. Could not extract spreadsheet ID.');
  process.exit(1);
}
const spreadsheetId = spreadsheetIdMatch[1];
console.log(`Spreadsheet ID: ${spreadsheetId}\n`);


// --- 2. Font Helper Functions ---

function fetchGoogleFontsCSS(fontFamily) {
  return new Promise((resolve, reject) => {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@400&display=swap`;
    console.log(`Fetching CSS for font: ${fontFamily}`);
    console.log(`URL: ${cssUrl}\n`);
    https.get(cssUrl, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch CSS: ${res.statusCode}`));
        return;
      }
      let cssData = '';
      res.on('data', (chunk) => {
        cssData += chunk;
      });
      res.on('end', () => {
        resolve(cssData);
      });
    }).on('error', reject);
  });
}

function extractFontInfos(cssData, inputFamily) {
  const fontInfos = [];
  // Match @font-face blocks
  const blockPattern = /\/\*\s*([^/*]+?)\s*\*\/\s*(@font-face\s*\{[\s\S]*?\})/gi;
  let match;
  while ((match = blockPattern.exec(cssData)) !== null) {
    const subset = match[1].trim().toLowerCase();
    const blockStr = match[2];

    // Check family
    const familyMatch = blockStr.match(/font-family\s*:\s*['\"]([^'\"]+)['\"]/i);
    if (!familyMatch) continue;
    let family = familyMatch[1].trim();

    // Check weight
    const weightMatch = blockStr.match(/font-weight\s*:\s*([\d,]+)/i);
    let weight = weightMatch ? weightMatch[1].trim() : '400';

    // Parse src url
    const srcPattern = /url\s*\(\s*(['\"]?)(https?:\/\/[^'"\)\s]+)\s*\1\s*\)\s*format\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/gi;
    let srcMatch;
    while ((srcMatch = srcPattern.exec(blockStr)) !== null) {
      const url = srcMatch[2];
      const format = srcMatch[3].toLowerCase();
      // Only want ttf or otf
      if (!['truetype', 'opentype'].includes(format)) continue;

      if (subset === 'latin') {
        const ext = format === 'truetype' ? 'ttf' : 'otf';
        const fileName = `${family.toLowerCase().replace(/\s+/g, '')}-${weight}.${ext}`;
        fontInfos.push({ url, fileName, family });
        break;
      }
    }
  }

  // Fallback: search for any TTF/OTF link if no specific latin subset block found
  if (fontInfos.length === 0) {
    const fallbackPattern = /url\s*\(\s*(['\"]?)(https?:\/\/[^'"\)\s]+\.(?:ttf|otf))\s*\1\s*\)/gi;
    let fbMatch;
    while ((fbMatch = fallbackPattern.exec(cssData)) !== null) {
      const url = fbMatch[2];
      const ext = path.extname(new URL(url).pathname) || '.ttf';
      const fileName = `${inputFamily.toLowerCase().replace(/\s+/g, '')}-regular${ext}`;
      fontInfos.push({ url, fileName, family: inputFamily });
      break;
    }
  }
  return fontInfos;
}

function downloadFont(fontUrl, filePath) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading font from: ${fontUrl}`);
    const file = fs.createWriteStream(filePath);
    https.get(fontUrl, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download font: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`Font downloaded to: ${filePath}\n`);
        resolve();
      });
    }).on('error', reject);
  });
}

async function getFontPath(fontFamily) {
  const fontDir = './fonts';
  if (!fs.existsSync(fontDir)) {
    fs.mkdirSync(fontDir, { recursive: true });
    console.log(`Created fonts directory: ${fontDir}`);
  }

  // Optimistic check: if we already have a file that looks right
  const simpleName = `${fontFamily.toLowerCase().replace(/\s+/g, '')}-regular.ttf`;
  const simplePath = path.join(fontDir, simpleName);
  if (fs.existsSync(simplePath)) {
    console.log(`Font file already exists (cached): ${simplePath}`);
    return { filePath: simplePath, family: fontFamily };
  }

  console.log(`Downloading Google Font: ${fontFamily}`);
  const cssData = await fetchGoogleFontsCSS(fontFamily);
  const fontInfos = extractFontInfos(cssData, fontFamily);

  if (fontInfos.length === 0) {
    throw new Error(`No TTF/OTF font files found for ${fontFamily}. It might only be available in WOFF2.`);
  }

  const info = fontInfos[0];
  const filePath = path.join(fontDir, info.fileName);

  if (fs.existsSync(filePath)) {
    console.log(`Font file already exists: ${filePath}`);
    return { filePath, family: info.family };
  }

  await downloadFont(info.url, filePath);
  return { filePath, family: info.family };
}


// --- 3. Image Download (Fixed for 303 Redirects) ---

async function downloadImageFromDrive(driveUrl, tempPath) {
  console.log(`Extracting file ID from Drive URL: ${driveUrl}`);
  // Extract ID from various drive URL formats
  let fileIdMatch = driveUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) || driveUrl.match(/id=([a-zA-Z0-9-_]+)/);

  if (!fileIdMatch) {
    throw new Error('Invalid Google Drive URL format. Could not extract file ID.');
  }
  const fileId = fileIdMatch[1];
  console.log(`Extracted file ID: ${fileId}`);
  console.log(`Downloading file using Google Drive API (alt=media)...`);

  // Use the Drive API to get the stream directly
  const dest = fs.createWriteStream(tempPath);
  try {
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    console.log(`Download stream initiated. Writing to: ${tempPath}`);
    await pipeline(res.data, dest);
    console.log(`Image downloaded successfully to: ${tempPath}\n`);
  } catch (err) {
    // Clean up if failed
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw new Error(`Drive Download API failed: ${err.message}`);
  }
}


// --- 4. Color Normalization ---

function normalizeColor(colorStr) {
  colorStr = colorStr.trim().toLowerCase();
  if (colorStr === 'white') return '#ffffff';
  if (colorStr === 'black') return '#000000';
  if (colorStr === 'red') return '#ff0000';
  if (colorStr.startsWith('#')) return colorStr;
  // If 6 hex digits without hash
  if (/^[0-9a-f]{6}$/.test(colorStr)) return `#${colorStr}`;
  return colorStr;
}


// --- 4B. Position Normalization ---

function normalizePosition(positionStr) {
  // Trim and lowercase for comparison
  const pos = positionStr.trim().toLowerCase();

  // Handle empty or null
  if (!pos) return 'TopCenter';

  // Normalize variations
  if (pos === 'top' || pos === 'topcenter') return 'TopCenter';
  if (pos === 'topleft') return 'TopLeft';
  if (pos === 'topright') return 'TopRight';

  if (pos === 'center' || pos === 'middle') return 'Center';
  if (pos === 'centerleft') return 'CenterLeft';
  if (pos === 'centerright') return 'CenterRight';

  if (pos === 'bottom' || pos === 'bottomcenter') return 'BottomCenter';
  if (pos === 'bottomleft') return 'BottomLeft';
  if (pos === 'bottomright') return 'BottomRight';

  // Default to TopCenter if unrecognized
  console.warn(`Unrecognized position "${positionStr}", defaulting to TopCenter`);
  return 'TopCenter';
}


// --- 5. Main Canvas Logic (Embed Text) ---

async function embedText(imagePath, textContent, fontFamily, positionStr, textColor, bgColor, bgAlpha) {
  console.log(`Embedding text "${textContent}" into image at ${imagePath}`);
  console.log(`Parameters - Font: ${fontFamily}, TextPosition: ${positionStr}, TextColor: ${textColor}, BgColor: ${bgColor}, BgAlpha: ${bgAlpha}\n`);

  const img = await loadImage(imagePath);
  console.log(`Image loaded - Dimensions: ${img.width}x${img.height}`);

  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, img.width, img.height);
  console.log('Image drawn to canvas');

  // Handle Fonts
  let actualFont = 'Arial';
  if (fontFamily.toLowerCase() !== 'arial') {
    try {
      console.log(`Registering custom Google Font: ${fontFamily}`);
      const fontData = await getFontPath(fontFamily);
      registerFont(fontData.filePath, { family: fontData.family });
      actualFont = fontData.family;
      console.log(`Font registered successfully: ${actualFont}`);
    } catch (e) {
      console.warn(`Could not load font ${fontFamily}, falling back to Arial. Error: ${e.message}`);
    }
  } else {
    console.log('Using default system font: Arial');
  }

  // Dynamic Font Size logic
  const envFontSizeStr = process.env.FONT_SIZE;
  const fontSize = envFontSizeStr ? parseInt(envFontSizeStr, 10) : 30;

  // Configure Context
  ctx.font = `${fontSize}px "${actualFont}"`;
  ctx.fillStyle = normalizeColor(textColor);

  let textAlign = 'center';
  let textBaseline = 'top';
  let x, y;

  // Normalize text position (where to place text on the image)
  const textPos = normalizePosition(positionStr);
  console.log(`Normalized TextPosition: ${textPos}`);

  // Calculate Position for text placement
  const padding = 10;
  switch (textPos) {
    case 'TopLeft':
      textAlign = 'left'; textBaseline = 'top'; x = padding; y = padding; break;
    case 'TopCenter':
      textAlign = 'center'; textBaseline = 'top'; x = img.width / 2; y = padding; break;
    case 'TopRight':
      textAlign = 'right'; textBaseline = 'top'; x = img.width - padding; y = padding; break;
    case 'CenterLeft':
      textAlign = 'left'; textBaseline = 'middle'; x = padding; y = img.height / 2; break;
    case 'Center':
      textAlign = 'center'; textBaseline = 'middle'; x = img.width / 2; y = img.height / 2; break;
    case 'CenterRight':
      textAlign = 'right'; textBaseline = 'middle'; x = img.width - padding; y = img.height / 2; break;
    case 'BottomLeft':
      textAlign = 'left'; textBaseline = 'bottom'; x = padding; y = img.height - padding; break;
    case 'BottomCenter':
      textAlign = 'center'; textBaseline = 'bottom'; x = img.width / 2; y = img.height - padding; break;
    case 'BottomRight':
      textAlign = 'right'; textBaseline = 'bottom'; x = img.width - padding; y = img.height - padding; break;
    default:
      textAlign = 'center'; textBaseline = 'top'; x = img.width / 2; y = padding;
  }

  ctx.textAlign = textAlign;
  ctx.textBaseline = textBaseline;

  // Draw Background if needed
  const metrics = ctx.measureText(textContent);
  const textWidth = metrics.width;

  // Height calculation: If env var exists -> 1.33x, else -> 40
  const textHeight = envFontSizeStr ? Math.ceil(fontSize * 1.33) : 40;

  if (bgColor) {
    const bgPad = 5;
    let rectX, rectY;

    // Calculate Rect X
    if (textAlign === 'left') rectX = x - bgPad;
    else if (textAlign === 'center') rectX = x - (textWidth / 2) - bgPad;
    else rectX = x - textWidth - bgPad; // right

    // Calculate Rect Y
    if (textBaseline === 'top') rectY = y - bgPad;
    else if (textBaseline === 'middle') rectY = y - (textHeight / 2) - bgPad;
    else rectY = y - textHeight - bgPad; // bottom

    const rectW = textWidth + (bgPad * 2);
    const rectH = textHeight + (bgPad * 2);

    console.log(`Drawing background rect at ${rectX},${rectY} size ${rectW}x${rectH}`);
    ctx.save();
    ctx.globalAlpha = bgAlpha;
    ctx.fillStyle = normalizeColor(bgColor);
    ctx.fillRect(rectX, rectY, rectW, rectH);
    ctx.restore();
  }

  // Draw Text
  ctx.fillText(textContent, x, y);
  console.log('Text drawn to canvas');

  return canvas.toBuffer('image/png');
}


// --- 6. Upload Logic ---

async function uploadToDrive(imageBuffer, fileName) {
  console.log(`Searching for AutoFB folder in Drive...`);
  const folderRes = await drive.files.list({
    q: "name contains 'autofb' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id, name)'
  });

  if (folderRes.data.files.length === 0) {
    throw new Error('No folder matching "autofb" or "AutoFB" found in Drive.');
  }

  const folder = folderRes.data.files[0];
  const folderId = folder.id;
  console.log(`Using folder: ${folder.name} (ID: ${folderId})\n`);

  console.log(`Preparing upload with filename: ${fileName}`);

  // Create a readable stream from buffer
  const bufferStream = new stream.PassThrough();
  bufferStream.end(imageBuffer);

  const file = await drive.files.create({
    resource: {
      name: fileName,
      parents: [folderId]
    },
    media: {
      mimeType: 'image/png',
      body: bufferStream
    },
    fields: 'id, name'
  });

  const fileId = file.data.id;
  console.log(`File uploaded successfully. ID: ${fileId}`);

  console.log('Setting public sharing permission...');
  await drive.permissions.create({
    fileId,
    resource: { role: 'reader', type: 'anyone' }
  });

  // We use this link format so it can be previewed/downloaded
  const shareUrl = `https://drive.google.com/file/d/${fileId}/view?usp=drivesdk`;
  console.log(`Shareable URL generated: ${shareUrl}\n`);
  return shareUrl;
}

async function updateRow(sheets, spreadsheetId, sheetTitle, rowNum, rowData) {
  const range = `${sheetTitle}!A${rowNum}`;
  console.log(`Updating row ${rowNum} in range ${range}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    resource: { values: [rowData] }
  });
  console.log(`Row ${rowNum} updated successfully.\n`);
}


// --- 7. Main Execution ---

async function main() {
  console.log('Fetching spreadsheet metadata...');
  const ssRes = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });
  const sheetTitle = ssRes.data.sheets[0].properties.title;
  console.log(`Using sheet title: ${sheetTitle}\n`);

  console.log('Reading data from sheet...');
  const valuesRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A1:Z1000`
  });

  const rows = valuesRes.data.values;
  if (!rows || rows.length === 0) {
    console.log('No data found in sheet.');
    return;
  }
  console.log(`Read ${rows.length} rows from sheet.\n`);

  const headers = rows[0];
  console.log('Headers found:', headers);

  // Map headers to indices
  const colMap = {};
  headers.forEach((h, i) => colMap[h.trim()] = i);

  // Verify required columns
  const requiredCols = [
    'EmbedText(yes/no)', 'TextContent', 'TextFont', 'TextPosition', 'TextColor',
    'TextBackground', 'TextEmbedComplete', 'ImageWithTextEmbedded',
    'GenImage', 'ImageWithLogoEmbedded', 'Company'
  ];
  for (const col of requiredCols) {
    if (!(col in colMap)) throw new Error(`Missing column: ${col}`);
  }
  console.log('All required columns present.\n');

  const tempDir = './temp';
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const numCols = headers.length;

  // --- LOOP ROWS ---
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    let row = rows[rowIndex];
    // Pad row if short
    if (row.length < numCols) {
      row = row.concat(new Array(numCols - row.length).fill(''));
    }

    const textCompleteCol = colMap['TextEmbedComplete'];
    if (row[textCompleteCol] === 'Complete') {
      console.log(`--- Skipping row ${rowIndex + 1} (already complete) ---`);
      continue;
    }

    console.log(`\n--- Processing row ${rowIndex + 1} ---`);

    // Check if EmbedText flag is set to 'yes'
    const embedTextFlag = (row[colMap['EmbedText(yes/no)']] || '').trim().toLowerCase();

    if (embedTextFlag !== 'yes') {
      console.log('EmbedText is not "yes", marking Complete and skipping.');
      row[textCompleteCol] = 'Complete';
      await updateRow(sheets, spreadsheetId, sheetTitle, rowIndex + 1, row);
      continue;
    }

    // Logic: check content
    const textContent = (row[colMap['TextContent']] || '').trim();
    if (!textContent) {
      console.log('Error: TextContent is blank.');
      row[textCompleteCol] = 'Error: TextContent is blank';
      await updateRow(sheets, spreadsheetId, sheetTitle, rowIndex + 1, row);
      continue;
    }

    // Logic: Font
    let fontFamily = (row[colMap['TextFont']] || 'Arial').trim();
    if (!fontFamily) fontFamily = 'Arial';

    // Logic: TextPosition (where to place text on the image)
    let textPositionRaw = (row[colMap['TextPosition']] || 'TopCenter').trim();
    const textPosition = normalizePosition(textPositionRaw);
    console.log(`TextPosition normalized: "${textPositionRaw}" -> "${textPosition}"`);

    // Logic: Color
    let tColor = (row[colMap['TextColor']] || 'White').trim();
    if (!tColor) tColor = 'White';
    tColor = normalizeColor(tColor);

    // Logic: Background
    let bgRaw = (row[colMap['TextBackground']] || 'Opaque Black').trim();
    if (!bgRaw) bgRaw = 'Opaque Black';

    let bgColor, bgAlpha;
    const bgLower = bgRaw.toLowerCase();
    if (bgLower === 'none') {
      bgColor = null;
      bgAlpha = 1.0;
    } else {
      // Normalize "Opaque Black" -> type=Opaque, color=Black
      let bgType = 'Opaque';
      if (bgRaw.toLowerCase().includes('translucent')) bgType = 'Translucent';
      else if (bgRaw.toLowerCase().includes('opaque')) bgType = 'Opaque';

      let bgColorStr = bgRaw.replace(/opaque|translucent/gi, '').trim();
      if (!bgColorStr) bgColorStr = 'Black';

      bgAlpha = (bgType === 'Translucent') ? 0.5 : 1.0;
      bgColor = normalizeColor(bgColorStr);
    }

    // Logic: Image Source
    let imageUrl = (row[colMap['ImageWithLogoEmbedded']] || '').trim();
    if (!imageUrl) {
      imageUrl = (row[colMap['GenImage']] || '').trim();
    }

    if (!imageUrl) {
      console.log('Error: No image URL available.');
      row[textCompleteCol] = 'Error: No image URL';
      await updateRow(sheets, spreadsheetId, sheetTitle, rowIndex + 1, row);
      continue;
    }

    const timestamp = Date.now();
    const tempPath = path.join(tempDir, `temp_${rowIndex}_${timestamp}.png`);

    try {
      // 1. Download
      await downloadImageFromDrive(imageUrl, tempPath);

      // 2. Embed Text (with TextPosition parameter)
      const finalBuffer = await embedText(
        tempPath,
        textContent,
        fontFamily,
        textPosition,
        tColor,
        bgColor,
        bgAlpha
      );

      // Cleanup temp
      fs.unlinkSync(tempPath);

      // 3. Upload
      const companyName = (row[colMap['Company']] || 'company').replace(/[^a-zA-Z0-9]/g, '_');
      const finalName = `${companyName}_text_${timestamp}.png`;
      const shareLink = await uploadToDrive(finalBuffer, finalName);

      // 4. Update Sheet
      row[colMap['ImageWithTextEmbedded']] = shareLink;
      row[textCompleteCol] = 'Complete';
      console.log('Row processing successful.');

    } catch (err) {
      console.error(`Row failed: ${err.message}`);
      row[textCompleteCol] = `Error: ${err.message}`;
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }

    await updateRow(sheets, spreadsheetId, sheetTitle, rowIndex + 1, row);
  }

  console.log('\n--- Script processing complete ---');
}

main().catch(console.error);