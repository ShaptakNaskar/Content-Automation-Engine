document.addEventListener('DOMContentLoaded', () => {
    // --- Elements ---
    const themeToggle = document.getElementById('theme-toggle');
    const authStatus = document.getElementById('auth-status');
    const authText = document.getElementById('auth-text');
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const configForm = document.getElementById('config-form');
    const btnRefreshFb = document.getElementById('btn-refresh-fb');
    const workflowOutput = document.getElementById('workflow-output');
    const btnRunOnce = document.getElementById('btn-run-once');
    const btnSchedule = document.getElementById('btn-schedule');
    const scheduleInterval = document.getElementById('schedule-interval');

    // --- Theme Management ---
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        document.body.setAttribute('data-theme', savedTheme);
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
        document.body.setAttribute('data-theme', 'light');
    }

    themeToggle.addEventListener('click', () => {
        const currentTheme = document.body.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.body.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });

    // --- API Helpers ---
    async function apiCall(endpoint, method = 'GET', body = null) {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body) options.body = JSON.stringify(body);

        try {
            const res = await fetch(endpoint, options);
            return await res.json();
        } catch (err) {
            console.error('API Error:', err);
            return { success: false, error: err.message };
        }
    }

    async function loadStatus() {
        const data = await apiCall('/api/status');

        if (data.loggedIn) {
            authStatus.querySelector('.status-dot').classList.add('active');
            authText.textContent = "Logged In (Token Active)";
            btnLogin.style.display = 'none';
            btnLogout.style.display = 'inline-block';
        } else {
            authStatus.querySelector('.status-dot').classList.remove('active');
            authText.textContent = "Not Logged In";
            btnLogin.style.display = 'inline-block';
            btnLogout.style.display = 'none';
        }

        if (data.config) {
            for (const [key, value] of Object.entries(data.config)) {
                const input = document.getElementById(key);
                if (input) input.value = value;
            }
        }
    }

    // --- Authentication ---
    btnLogin.addEventListener('click', async () => {
        authText.textContent = "Launching login window...";
        btnLogin.disabled = true;
        const res = await apiCall('/api/run', 'POST', { script: '0.oauth.js' });
        if (res.success) {
            alert('Login procedure completed.');
            loadStatus();
        } else {
            alert('Login failed: ' + (res.error || res.message));
        }
        btnLogin.disabled = false;
    });

    btnLogout.addEventListener('click', async () => {
        if (confirm("Are you sure you want to logout? This will delete the local token.")) {
            await apiCall('/api/logout', 'POST');
            loadStatus();
        }
    });

    // --- Configuration ---
    configForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(configForm);
        const config = Object.fromEntries(formData.entries());

        const msgSpan = document.getElementById('config-msg');
        msgSpan.textContent = "Saving...";

        const res = await apiCall('/api/config', 'POST', config);

        if (res.success) {
            msgSpan.textContent = "Saved!";
            msgSpan.style.color = "var(--success-color)";
            setTimeout(() => msgSpan.textContent = "", 3000);
        } else {
            msgSpan.textContent = "Error: " + res.error;
            msgSpan.style.color = "var(--danger-color)";
        }
    });

    // --- Facebook Token Refresh ---
    btnRefreshFb.addEventListener('click', async () => {
        btnRefreshFb.disabled = true;
        btnRefreshFb.textContent = "Refreshing...";
        const res = await apiCall('/api/run', 'POST', { script: '0.2refreshfbtoken.js' });
        if (res.success) {
            alert("Token refreshed successfully.");
            loadStatus();
        } else {
            alert("Failed to refresh token: " + (res.error || res.output));
        }
        btnRefreshFb.disabled = false;
        btnRefreshFb.textContent = "Generate Token";
    });

    // --- SSE & Logging ---
    const latestLogBox = document.createElement('div');
    latestLogBox.id = 'latest-log-box';
    latestLogBox.className = 'card';
    latestLogBox.style.marginTop = '2rem';
    latestLogBox.style.backgroundColor = '#000';
    latestLogBox.style.color = '#0f0';
    latestLogBox.style.fontFamily = 'monospace';
    latestLogBox.style.padding = '1rem';
    latestLogBox.innerHTML = '<strong>Latest Output:</strong> <span id="log-content">Waiting for activity...</span>';

    // Insert after workflow section, before automation section
    const workflowSection = document.getElementById('workflow-section');
    workflowSection.parentNode.insertBefore(latestLogBox, workflowSection.nextSibling);

    const logContentSpan = document.getElementById('log-content');

    const evtSource = new EventSource('/api/events');

    evtSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            // Update Latest Log Box (Status)
            if (data.type === 'stdout' || data.type === 'stderr') {
                logContentSpan.textContent = data.message;
            } else if (data.type === 'start') {
                logContentSpan.textContent = `--- Started ${data.script} ---`;
                logContentSpan.style.color = '#0ff';
            } else if (data.type === 'end') {
                logContentSpan.textContent = `--- Finished ${data.script} (Code: ${data.code}) ---`;
                logContentSpan.style.color = data.code === 0 ? '#0f0' : '#f00';
                setTimeout(() => { logContentSpan.style.color = '#0f0'; }, 3000);
            }

            // Update Main Console (Cumulative)
            if (data.type === 'stdout' || data.type === 'stderr') {
                workflowOutput.style.display = 'block';
                workflowOutput.textContent += `\n${data.message}`;
                workflowOutput.scrollTop = workflowOutput.scrollHeight;
            } else if (data.type === 'start') {
                workflowOutput.style.display = 'block';
                workflowOutput.textContent += `\n--- Started ${data.script} ---`;
            } else if (data.type === 'end') {
                workflowOutput.textContent += `\n--- Finished ${data.script} (Code: ${data.code}) ---`;
            }
        } catch (e) {
            console.error("SSE Parse Error", e);
        }
    };

    // --- Workflow Execution ---
    function logOutput(text) {
        workflowOutput.style.display = 'block';
        workflowOutput.textContent += `\n[UI] ${text}`;
        workflowOutput.scrollTop = workflowOutput.scrollHeight;
    }

    document.querySelectorAll('.btn-action').forEach(btn => {
        btn.addEventListener('click', async () => {
            const script = btn.getAttribute('data-script');
            const originalText = btn.textContent;

            btn.disabled = true;
            btn.textContent = "Running...";

            // Show console immediately
            workflowOutput.style.display = 'block';
            workflowOutput.textContent += `\n\n> Requesting execution of ${script}...`;

            // We initiate the run. Streaming logs will update the UI via SSE.
            const res = await apiCall('/api/run', 'POST', { script });

            if (!res.success) {
                logOutput(`Error:\n${res.error}\n\nOutput:\n${res.output || ''}`);
            }

            btn.disabled = false;
            btn.textContent = originalText;
        });
    });

    // --- Automation buttons ---
    btnRunOnce.addEventListener('click', async () => {
        btnRunOnce.disabled = true;
        btnRunOnce.textContent = "Running Workflow...";

        // Show console immediately
        workflowOutput.style.display = 'block';
        workflowOutput.textContent += `\n\n> Requesting full workflow run...`;

        const res = await apiCall('/api/run', 'POST', {
            script: 'mainrunner.js',
            args: ['--run-once']
        });

        if (!res.success) {
            logOutput(`Error:\n${res.error}`);
        }

        btnRunOnce.disabled = false;
        btnRunOnce.textContent = "Run Full Workflow";
    });

    const btnStop = document.getElementById('btn-stop');
    btnStop.addEventListener('click', async () => {
        if (confirm("Stop current workflow/schedule?")) {
            const res = await apiCall('/api/stop', 'POST');
            alert(res.message);
        }
    });

    btnSchedule.addEventListener('click', async () => {
        const val = scheduleInterval.value;
        const res = await apiCall('/api/schedule', 'POST', { interval: val ? parseInt(val) : 0 });
        alert(res.message);
    });

    // --- Export Log ---
    const btnExportLog = document.getElementById('btn-export-log');
    if (btnExportLog) {
        btnExportLog.addEventListener('click', () => {
            const keys = Object.keys(localStorage).filter(k => k.startsWith('log_'));
            // We are using the text content of the div, not local storage
            const logContent = workflowOutput.textContent;
            if (!logContent) {
                alert("No logs to export.");
                return;
            }

            const blob = new Blob([logContent], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `workflow-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            a.click();
            URL.revokeObjectURL(url);
        });
    }

    // Init
    loadStatus();
});
