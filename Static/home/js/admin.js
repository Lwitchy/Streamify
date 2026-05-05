document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.admin-section');
    const tableSelect = document.getElementById('db-table-select');
    const saveConfigBtn = document.getElementById('save-config');
    const saveLimitsBtn = document.getElementById('save-limits');
    const maintenanceToggle = document.getElementById('maintenance-toggle-label');
    const lockdownToggle = document.getElementById('lockdown-toggle-label');
    const rawViewToggle = document.getElementById('raw-view-toggle');
    const rawViewToggleContainer = document.getElementById('raw-view-toggle-container');
    const rawViewSwitch = document.getElementById('raw-view-switch');

    let currentConfig = {};
    let currentUser = null;

    // --- Utilities ---
    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        const htmlEntities = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return String(str).replace(/[&<>"']/g, s => htmlEntities[s]);
    }

    window.copyToClipboard = (text, el) => {
        navigator.clipboard.writeText(text).then(() => {
            const originalText = el.innerText;
            el.innerText = 'Copied!';
            el.style.color = '#10b981';
            setTimeout(() => {
                el.innerText = originalText;
                el.style.color = '';
            }, 1000);
        });
    };

    window.viewSystemLogs = () => {
        const databaseNavItem = document.querySelector('.nav-item[data-section="database"]');
        if (databaseNavItem) databaseNavItem.click();
        tableSelect.value = 'system_logs';
        tableSelect.dispatchEvent(new Event('change'));
    };

    // --- User Management ---
    async function fetchMe() {
        try {
            const res = await fetch('/api/me');
            currentUser = await res.json();

            const isOwner = currentUser && currentUser.role === 'Owner';

            // Check for Owner role to show Raw View toggle
            if (isOwner) {
                rawViewToggleContainer.style.display = 'flex';
                rawViewToggleContainer.classList.remove('hidden');
            } else {
                // Remove Owner-only table options for regular Admins
                const optDm = document.getElementById('opt-dm-messages');
                if (optDm) optDm.remove();
            }
        } catch (err) {
            console.error('Failed to fetch user data:', err);
        }
    }

    // Navigation
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            if (item.hasAttribute('data-section')) {
                const sectionId = item.getAttribute('data-section');

                navItems.forEach(n => n.classList.remove('active'));
                item.classList.add('active');

                sections.forEach(s => s.classList.remove('active'));
                document.getElementById(sectionId).classList.add('active');

                if (sectionId === 'dashboard') fetchStats();
                if (sectionId === 'config') fetchConfig();
                if (sectionId === 'database') fetchTableData(tableSelect.value);
            }
        });
    });

    // --- Dashboard ---
    async function fetchStats() {
        try {
            const res = await fetch('/api/admin/stats');
            const stats = await res.json();

            document.getElementById('stat-users').textContent = stats.users;
            document.getElementById('stat-songs').textContent = stats.songs;
            document.getElementById('stat-posts').textContent = stats.posts;
            document.getElementById('stat-sessions').textContent = stats.sessions;

            const uptimeMinutes = Math.floor(stats.uptime / 60);
            const uptimeHours = Math.floor(uptimeMinutes / 60);
            document.getElementById('stat-uptime').textContent = `${uptimeHours}h ${uptimeMinutes % 60}m`;
            document.getElementById('stat-node').textContent = stats.node_version;
            document.getElementById('stat-platform').textContent = stats.platform;
        } catch (err) {
            console.error('Failed to fetch stats:', err);
        }
    }

    // --- Config ---
    async function fetchConfig() {
        try {
            const res = await fetch('/api/admin/config');
            currentConfig = await res.json();

            updateConfigUI();
        } catch (err) {
            console.error('Failed to fetch config:', err);
        }
    }

    function updateConfigUI() {
        const toggle = document.getElementById('maintenance-toggle-label');
        const status = document.getElementById('maintenance-status');
        const message = document.getElementById('maintenance-message');

        if (currentConfig.maintenance_mode) {
            toggle.classList.add('toggle-active');
            status.textContent = 'Enabled';
            status.style.color = '#10b981';
        } else {
            toggle.classList.remove('toggle-active');
            status.textContent = 'Disabled';
            status.style.color = '#94949e';
        }

        message.value = currentConfig.maintenance_message || '';

        const lToggle = document.getElementById('lockdown-toggle-label');
        const lStatus = document.getElementById('lockdown-status');
        if (currentConfig.lockdown_new_posts) {
            lToggle.classList.add('toggle-active');
            lStatus.textContent = 'Enabled';
            lStatus.style.color = '#10b981';
        } else {
            lToggle.classList.remove('toggle-active');
            lStatus.textContent = 'Disabled';
            lStatus.style.color = '#94949e';
        }

        // Rate Limit fields
        const rl = currentConfig.ratelimits || {};
        document.getElementById('limit-api').value = rl.api || 200;
        document.getElementById('limit-social').value = rl.social || 20;
        document.getElementById('limit-comment').value = rl.comment || 10;
        document.getElementById('limit-post').value = rl.post || 1;
        document.getElementById('limit-youtube').value = rl.youtube_max || 2;
    }

    maintenanceToggle.addEventListener('click', () => {
        currentConfig.maintenance_mode = !currentConfig.maintenance_mode;
        updateConfigUI();
    });

    lockdownToggle.addEventListener('click', () => {
        currentConfig.lockdown_new_posts = !currentConfig.lockdown_new_posts;
        updateConfigUI();
    });

    saveConfigBtn.addEventListener('click', async () => {
        const message = document.getElementById('maintenance-message').value;
        const payload = {
            maintenance_mode: currentConfig.maintenance_mode,
            maintenance_message: message,
            lockdown_new_posts: currentConfig.lockdown_new_posts
        };

        try {
            const res = await fetch('/api/admin/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            if (result.success) {
                alert('Primary configuration saved and logged.');
            }
        } catch (err) {
            alert('Failed to save configuration');
        }
    });

    saveLimitsBtn.addEventListener('click', async () => {
        const payload = {
            ratelimits: {
                api: parseInt(document.getElementById('limit-api').value),
                social: parseInt(document.getElementById('limit-social').value),
                comment: parseInt(document.getElementById('limit-comment').value),
                post: parseInt(document.getElementById('limit-post').value),
                youtube_max: parseInt(document.getElementById('limit-youtube').value)
            }
        };

        try {
            const res = await fetch('/api/admin/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            if (result.success) {
                alert('Rate limits updated successfully! The server is now respecting these new limits.');
                currentConfig = result.config;
            }
        } catch (err) {
            alert('Failed to update rate limits');
        }
    });

    // --- Database Viewer ---
    tableSelect.addEventListener('change', () => {
        fetchTableData(tableSelect.value);
    });

    // Handle the Raw View toggle
    if (rawViewToggle) {
        const rawViewLabel = rawViewToggle.closest('.toggle-container');

        rawViewToggle.addEventListener('change', () => {
            if (rawViewToggle.checked) {
                rawViewLabel.classList.add('toggle-active');
            } else {
                rawViewLabel.classList.remove('toggle-active');
            }
            fetchTableData(tableSelect.value);
        });
    }

    async function fetchTableData(table) {
        const thead = document.getElementById('db-thead');
        const tbody = document.getElementById('db-tbody');
        const isRawView = rawViewToggle.checked;

        thead.innerHTML = '<tr><th>Loading...</th></tr>';
        tbody.innerHTML = '';

        try {
            const res = await fetch(`/api/admin/db/data/${table}`);
            const data = await res.json();

            // Handle errors (like 403)
            if (data.error) {
                thead.innerHTML = '<tr><th>Access Denied</th></tr>';
                tbody.innerHTML = `<tr><td colspan="100" style="text-align:center; padding:60px; color:var(--danger); background:rgba(239, 68, 68, 0.05); font-weight:600;">${escapeHTML(data.error)}</td></tr>`;
                return;
            }

            if (data.length === 0) {
                thead.innerHTML = '<tr><th>No Data</th></tr>';
                tbody.innerHTML = '<tr><td colspan="100" style="text-align:center; padding:60px; color:#555; background:rgba(0,0,0,0.1);">This table is empty.</td></tr>';
                return;
            }

            // Generate Headers
            const headers = Object.keys(data[0]);
            thead.innerHTML = `<tr>${headers.map(h => `<th>${escapeHTML(h.replace(/_/g, ' '))}</th>`).join('')}</tr>`;

            // Generate Rows
            tbody.innerHTML = data.map(row => {
                return `<tr>${headers.map(h => {
                    let val = row[h];
                    if (val === null || val === undefined) return '<td class="null-value">NULL</td>';

                    const valStr = String(val);
                    const escapedVal = escapeHTML(valStr);

                    // If Raw View is ON
                    if (isRawView) {
                        return `<td class="cell-hash" onclick="copyToClipboard('${escapedVal}', this)" title="Click to copy">${escapedVal}</td>`;
                    }

                    // Roles
                    if (h === 'role') {
                        return `<td><span class="tag-role role-${escapedVal}">${escapedVal}</span></td>`;
                    }

                    // Dates
                    if (valStr.includes('T') && valStr.includes('Z')) {
                        return `<td style="color:#ffffff99;">${new Date(val).toLocaleString()}</td>`;
                    }

                    // Images (Click to open in new tab)
                    if (valStr.startsWith('/Static/') && /\.(jpg|png|webp|jpeg)$/i.test(valStr)) {
                        return `<td><div style="display:flex;align-items:center;gap:10px;"><a href="${escapedVal}" target="_blank"><img src="${escapedVal}" class="td-thumbnail" title="Click to view full image"></a><span class="cell-path">${escapedVal}</span></div></td>`;
                    }

                    // Technical fields
                    if (h.toLowerCase().includes('id') || h.toLowerCase().includes('password') || h.toLowerCase().includes('hash')) {
                        return `<td class="cell-id" onclick="copyToClipboard('${escapedVal}', this)" title="Click to copy">${escapedVal}</td>`;
                    }

                    return `<td title="${escapedVal}">${escapedVal}</td>`;
                }).join('')}</tr>`;
            }).join('');

        } catch (err) {
            thead.innerHTML = '<tr><th style="color: var(--danger)">Error loading data</th></tr>';
            console.error('DB Fetch error:', err);
        }
    }

    // Initial Load
    fetchMe();
    fetchStats();
});
