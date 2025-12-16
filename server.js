const express = require('express');
const cors = require('cors');
const fs = require('fs'); // Use fs for sync/stream operations if needed
const fsPromises = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const dotenv = require('dotenv');
const cron = require('node-cron');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Paths
const ENV_PATH = path.join(__dirname, '.env');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// --- Helper Functions ---

// Global state for process control
let activeChildProcess = null;
let scheduleTimeout = null;
let isScheduled = false;

const EventEmitter = require('events');
const logEmitter = new EventEmitter();

// Helper to run a script and return promise
const runScript = (scriptName, args = []) => {
    return new Promise((resolve, reject) => {
        const cmd = 'node';
        const finalArgs = [scriptName, ...args];
        console.log(`Executing: ${cmd} ${finalArgs.join(' ')}`);

        // Emit start event
        logEmitter.emit('log', { type: 'start', script: scriptName });

        const process = spawn(cmd, finalArgs, { cwd: __dirname });
        activeChildProcess = process; // Track process

        let stdoutData = '';
        let stderrData = '';

        process.stdout.on('data', (data) => {
            const str = data.toString();
            console.log(`[${scriptName}] ${str}`);
            // Emit log event for each line
            str.split('\n').forEach(line => {
                if (line.trim()) logEmitter.emit('log', { type: 'stdout', script: scriptName, message: line.trim() });
            });
            stdoutData += str;
        });

        process.stderr.on('data', (data) => {
            const str = data.toString();
            console.error(`[${scriptName}] ${str}`);
            str.split('\n').forEach(line => {
                if (line.trim()) logEmitter.emit('log', { type: 'stderr', script: scriptName, message: line.trim() });
            });
            stderrData += str;
        });

        process.on('close', (code) => {
            activeChildProcess = null; // Clear process tracking
            logEmitter.emit('log', { type: 'end', script: scriptName, code });
            if (code === 0) {
                resolve(stdoutData);
            } else {
                reject(new Error(`Script exited with code ${code}. Error: ${stderrData}`));
            }
        });
    });
};

// --- SSE Endpoint ---
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const onLog = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    logEmitter.on('log', onLog);

    req.on('close', () => {
        logEmitter.off('log', onLog);
    });
});

// --- API Endpoints ---

// 1. Get Status (Login & Env Config)
app.get('/api/status', async (req, res) => {
    let loggedIn = false;
    try {
        await fsPromises.access(TOKEN_PATH);
        loggedIn = true;
    } catch (e) {
        loggedIn = false;
    }

    // Read .env to see what's set
    let config = {};
    try {
        const envFile = await fsPromises.readFile(ENV_PATH, 'utf8');
        const lines = envFile.split('\n');
        lines.forEach(line => {
            const [key, ...valParts] = line.split('=');
            if (key && valParts) {
                let val = valParts.join('=');
                // Trim quotes if present
                val = val.trim().replace(/^["'](.*)["']$/, '$1');
                config[key.trim()] = val;
            }
        });
    } catch (e) {
        // .env might not exist yet
    }

    res.json({
        loggedIn,
        config: {
            SHEET_URL: config.SHEET_URL || '',
            OPENAI_KEY: config.OPENAI_KEY || '',
            LOGO_SIZE: config.LOGO_SIZE || '0.1',
            FONT_SIZE: config.FONT_SIZE || '20',
            FB_APPID: config.FB_APPID || '',
            FB_APPSECRET: config.FB_APPSECRET || '',
            FB_USER_ACCESS_TOKEN: config.FB_USER_ACCESS_TOKEN || '',
            PAGE_ID: config.PAGE_ID || '',
            PAGE_TOKEN: config.PAGE_TOKEN || ''
        }
    });
});

// 2. Save Config (.env)
app.post('/api/config', async (req, res) => {
    const newConfig = req.body;
    let envContent = '';

    // We strictly define the order to match user expectation or keep it clean
    for (const [key, value] of Object.entries(newConfig)) {
        envContent += `${key}=${value}\n`;
    }

    try {
        await fsPromises.writeFile(ENV_PATH, envContent);
        // Reload dotenv
        dotenv.config({ override: true });
        res.json({ success: true, message: 'Configuration saved.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Run Script
app.post('/api/run', async (req, res) => {
    const { script, args } = req.body;

    // Whitelist scripts for security (optional but good practice)
    const allowedScripts = [
        '0.oauth.js',
        '0.1.createsheetlayout.js',
        '0.2refreshfbtoken.js', // The user filename
        '1.gencontent.js',
        '2.genimage.js',
        '3.embedlogo.js',
        '4.embedtxt.js',
        '5.post2fbgen3.js',
        'mainrunner.js'
    ];

    if (!allowedScripts.includes(script)) {
        return res.status(400).json({ success: false, message: 'Invalid script requested' });
    }

    try {
        const output = await runScript(script, args || []);
        res.json({ success: true, output });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Logout
app.post('/api/logout', async (req, res) => {
    try {
        await fsPromises.unlink(TOKEN_PATH);
        res.json({ success: true });
    } catch (err) {
        // If file doesn't exist, technically already logged out
        res.json({ success: true });
    }
});

// 5. Scheduler (Wait-after-finish)
// Uses recursive timeout instead of fixed cron to prevent overlaps

const runScheduledLoop = async (intervalMinutes) => {
    if (!isScheduled) return;

    try {
        console.log(`Starting scheduled run. Next run in ~${intervalMinutes} + execution time minutes.`);
        await runScript('mainrunner.js', ['--run-once']);
    } catch (err) {
        console.error('Scheduled task failed:', err);
    }

    // Only schedule next if still active
    if (isScheduled) {
        const ms = intervalMinutes * 60 * 1000;
        console.log(`Run complete. Waiting ${intervalMinutes} minutes before next run...`);
        logEmitter.emit('log', { type: 'stdout', script: 'Scheduler', message: `Run complete. Waiting ${intervalMinutes} minutes...` });

        scheduleTimeout = setTimeout(() => {
            runScheduledLoop(intervalMinutes);
        }, ms);
    }
};

app.post('/api/schedule', (req, res) => {
    const { interval } = req.body; // in minutes

    // Stop existing
    isScheduled = false;
    if (scheduleTimeout) clearTimeout(scheduleTimeout);
    if (activeChildProcess) {
        // Optional: kill current if restarting schedule? 
        // For now, we just let it finish or user can use Stop button.
    }

    if (!interval) {
        return res.json({ success: true, message: 'Schedule stopped' });
    }

    isScheduled = true;
    console.log(`Scheduling mainrunner.js every ${interval} minutes (wait-after-finish)`);

    // Start first immediately
    runScheduledLoop(interval);

    res.json({ success: true, message: `Scheduled every ${interval} minutes (sequential)` });
});

// 6. Stop Workflow
app.post('/api/stop', (req, res) => {
    let message = "Stop requested.";

    // 1. Cancel Schedule
    if (isScheduled || scheduleTimeout) {
        isScheduled = false;
        if (scheduleTimeout) clearTimeout(scheduleTimeout);
        message += " Schedule cancelled.";
    }

    // 2. Kill Process
    if (activeChildProcess) {
        activeChildProcess.kill('SIGINT'); // Try graceful first, or SIGTERM
        activeChildProcess = null;
        message += " Active process killed.";
    } else {
        message += " No active process found.";
    }

    console.log(message);
    logEmitter.emit('log', { type: 'stdout', script: 'System', message: `[STOP] ${message}` });

    res.json({ success: true, message });
});


// Start Server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop');
});
