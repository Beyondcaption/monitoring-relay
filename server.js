const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
 
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
 
// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // ✅ Größeres Limit für Screenshots!
app.use(express.static('public'));
 
// In-Memory Storage
const agents = new Map();
const admins = new Set();
const screenshots = new Map();
const activities = new Map();
const downloads = new Map();
const creatorProfiles = new Map();
 
// ============================================
// 🔥 SUPABASE CONFIGURATION
// ============================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
 
if (!supabaseUrl || !supabaseKey) {
    console.error('❌ CRITICAL: SUPABASE_URL and SUPABASE_KEY must be set!');
    console.error('💡 Set them in Railway → Settings → Variables');
    process.exit(1);
}
 
const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Supabase client initialized');
console.log(`📡 Connected to: ${supabaseUrl}`);
 
// ============================================
// 💾 PERSISTENT USER STORAGE (SUPABASE)
// ============================================
 
// User Cache (in-memory for performance)
const users = new Map();
 
// Load users from Supabase
async function loadUsers() {
    try {
        console.log('📡 Loading users from Supabase...');
        const { data, error } = await supabase
            .from('users')
            .select('*');
        
        if (error) throw error;
        
        users.clear();
        data.forEach(user => {
            users.set(user.username, {
                username: user.username,
                password: user.password,
                employeeId: user.employee_id,
                name: user.name,
                role: user.role,
                createdAt: user.created_at,
                lastLogin: user.last_login
            });
        });
        
        console.log(`✅ Loaded ${users.size} users from Supabase`);
    } catch (error) {
        console.error('❌ Error loading users from Supabase:', error.message);
    }
}
 
// Save/Update single user in Supabase
async function saveUser(user) {
    try {
        const { data, error } = await supabase
            .from('users')
            .upsert({
                username: user.username,
                password: user.password,
                employee_id: user.employeeId,
                name: user.name,
                role: user.role,
                created_at: user.createdAt,
                last_login: user.lastLogin
            }, {
                onConflict: 'username'
            });
        
        if (error) throw error;
        
        // Update cache
        users.set(user.username, user);
        console.log(`💾 Saved user to Supabase: ${user.username}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving user to Supabase:', error.message);
        return false;
    }
}
 
// Delete user from Supabase
async function deleteUserFromDB(username) {
    try {
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('username', username);
        
        if (error) throw error;
        
        // Update cache
        users.delete(username);
        console.log(`🗑️ Deleted user from Supabase: ${username}`);
        return true;
    } catch (error) {
        console.error('❌ Error deleting user from Supabase:', error.message);
        return false;
    }
}
 
// Load users on startup
loadUsers();

// ============================================
// 💾 CREATOR PROFILES (SUPABASE)
// ============================================

async function loadCreatorProfiles() {
    try {
        const { data, error } = await supabase.from('creator_profiles').select('*');
        if (error) throw error;
        creatorProfiles.clear();
        data.forEach(p => creatorProfiles.set(p.id, p));
        console.log(`✅ Loaded ${creatorProfiles.size} creator profiles`);
    } catch (error) {
        console.error('❌ Error loading creator profiles:', error.message);
    }
}

async function saveCreatorProfile(profile) {
    try {
        const { data, error } = await supabase
            .from('creator_profiles')
            .upsert(profile, { onConflict: 'id' })
            .select()
            .single();
        if (error) throw error;
        creatorProfiles.set(data.id, data);
        return data;
    } catch (error) {
        console.error('❌ Error saving creator profile:', error.message);
        return null;
    }
}

async function deleteCreatorProfile(id) {
    try {
        const { error } = await supabase.from('creator_profiles').delete().eq('id', id);
        if (error) throw error;
        creatorProfiles.delete(id);
        return true;
    } catch (error) {
        console.error('❌ Error deleting creator profile:', error.message);
        return false;
    }
}

loadCreatorProfiles();

// Admin key middleware
function adminAuth(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}
 
console.log('🚀 Monitoring Relay Server starting...');
 
// ✅ AUTO-CLEANUP CONFIGURATION
const MAX_ITEMS_PER_EMPLOYEE = 100;
const MAX_AGE_DAYS = 30;
const CLEANUP_INTERVAL_HOURS = 24;
 
// ✅ Cleanup Function - Läuft alle 24h
function cleanupOldData() {
    const now = Date.now();
    const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000; // 30 Tage in Millisekunden
    
    console.log('🧹 Running automatic cleanup...');
    
    let totalRemoved = 0;
    
    // Cleanup Screenshots
    for (const [employeeId, items] of screenshots.entries()) {
        const before = items.length;
        
        // Remove items older than 30 days
        const filtered = items.filter(item => {
            const age = now - new Date(item.timestamp).getTime();
            return age < maxAge;
        });
        
        // Keep only last 100 items
        const limited = filtered.slice(0, MAX_ITEMS_PER_EMPLOYEE);
        
        screenshots.set(employeeId, limited);
        
        const removed = before - limited.length;
        if (removed > 0) {
            console.log(`🧹 Removed ${removed} old screenshots for employee ${employeeId}`);
            totalRemoved += removed;
        }
    }
    
    // Cleanup Downloads
    for (const [employeeId, items] of downloads.entries()) {
        const before = items.length;
        
        // Remove items older than 30 days
        const filtered = items.filter(item => {
            const age = now - new Date(item.timestamp).getTime();
            return age < maxAge;
        });
        
        // Keep only last 100 items
        const limited = filtered.slice(0, MAX_ITEMS_PER_EMPLOYEE);
        
        downloads.set(employeeId, limited);
        
        const removed = before - limited.length;
        if (removed > 0) {
            console.log(`🧹 Removed ${removed} old downloads for employee ${employeeId}`);
            totalRemoved += removed;
        }
    }
    
    // Cleanup Activities (keep last 500 per employee, remove older than 30 days)
    for (const [employeeId, items] of activities.entries()) {
        const before = items.length;
        
        const filtered = items.filter(item => {
            const age = now - new Date(item.timestamp).getTime();
            return age < maxAge;
        });
        
        const limited = filtered.slice(0, 500);
        activities.set(employeeId, limited);
        
        const removed = before - limited.length;
        if (removed > 0) {
            console.log(`🧹 Removed ${removed} old activities for employee ${employeeId}`);
            totalRemoved += removed;
        }
    }
    
    console.log(`✅ Cleanup complete! Removed ${totalRemoved} total items`);
}
 
// ✅ Start automatic cleanup (runs every 24 hours)
setInterval(cleanupOldData, CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000);
console.log(`🧹 Auto-cleanup scheduled: Every ${CLEANUP_INTERVAL_HOURS}h, Max ${MAX_AGE_DAYS} days, Max ${MAX_ITEMS_PER_EMPLOYEE} items/employee`);
 
// Run cleanup on startup (after 5 seconds)
setTimeout(cleanupOldData, 5000);
 
// ============================================
// REST API ENDPOINTS
// ============================================
 
// Root → Dashboard
app.get('/', (req, res) => {
    res.redirect('/dashboard.html');
});

// Health Check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        agents: agents.size,
        admins: admins.size,
        uptime: Math.floor(process.uptime()),
        memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    });
});
 
// ============================================
// USER MANAGEMENT ENDPOINTS
// ============================================
 
// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    const user = users.get(username);
    
    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Update lastLogin
    user.lastLogin = new Date().toISOString();
    await saveUser(user);
    
    res.json({
        success: true,
        user: {
            username: user.username,
            employeeId: user.employeeId,
            role: user.role
        }
    });
});
 
// Get All Users (Admin only)
app.get('/api/admin/users', adminAuth, (req, res) => {
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        employeeId: u.employeeId,
        role: u.role,
        createdAt: u.createdAt
    }));
    
    res.json({ users: userList });
});
 
// Create User (Admin only)
app.post('/api/admin/users', adminAuth, async (req, res) => {
    const { username, password, employeeName } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (users.has(username)) {
        return res.status(409).json({ error: 'Username already exists' });
    }
    
    // Generate next employeeId
    const existingIds = Array.from(users.values()).map(u => u.employeeId);
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0;
    const newEmployeeId = maxId + 1;
    
    const newUser = {
        username,
        password,
        employeeId: newEmployeeId,
        name: employeeName || username,
        role: 'employee',
        createdAt: new Date().toISOString()
    };
    
    const success = await saveUser(newUser);
    
    if (!success) {
        return res.status(500).json({ error: 'Failed to save user' });
    }
    
    res.json({
        success: true,
        user: {
            username: newUser.username,
            employeeId: newUser.employeeId,
            role: newUser.role
        }
    });
});
 
// Delete User (Admin only)
app.delete('/api/admin/users/:username', adminAuth, async (req, res) => {
    const { username } = req.params;
    
    if (username === 'admin') {
        return res.status(403).json({ error: 'Cannot delete admin user' });
    }
    
    if (!users.has(username)) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    const success = await deleteUserFromDB(username);
    
    if (!success) {
        return res.status(500).json({ error: 'Failed to delete user' });
    }
    
    res.json({ success: true });
});
 
// Update User Password (Admin only)
app.put('/api/admin/users/:username/password', adminAuth, async (req, res) => {
    const { username } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword) {
        return res.status(400).json({ error: 'New password required' });
    }
    
    const user = users.get(username);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    user.password = newPassword;
    const success = await saveUser(user);
    
    if (!success) {
        return res.status(500).json({ error: 'Failed to update password' });
    }
    
    res.json({ success: true });
});
 
// ============================================
// USER MANAGEMENT ALIASES (für Dashboard)
// ============================================
 
// Create User - Alias mit auto-generated password
app.post('/api/users/create', adminAuth, async (req, res) => {
    const { username, employeeName } = req.body;
    
    if (!username || !employeeName) {
        return res.status(400).json({ error: 'Username and employeeName required' });
    }
    
    if (users.has(username)) {
        return res.status(409).json({ error: 'Username already exists' });
    }
    
    // Generate random password
    const password = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
    
    // Generate next employeeId
    const existingIds = Array.from(users.values()).map(u => u.employeeId);
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0;
    const newEmployeeId = maxId + 1;
    
    const newUser = {
        username,
        password,
        employeeId: newEmployeeId,
        name: employeeName || username,
        role: 'employee',
        createdAt: new Date().toISOString()
    };
    
    const success = await saveUser(newUser);
    
    if (!success) {
        return res.status(500).json({ error: 'Failed to save user' });
    }
    
    console.log(`👤 New user created: ${username} (ID: ${newEmployeeId})`);
    
    res.json({
        success: true,
        username: newUser.username,
        password: password, // ⚠️ Only returned once!
        employeeId: newUser.employeeId,
        employeeName: newUser.name
    });
});
 
// Delete User by ID - Alias
app.delete('/api/users/:employeeId', adminAuth, async (req, res) => {
    const employeeId = parseInt(req.params.employeeId);
    
    if (employeeId === 0) {
        return res.status(403).json({ error: 'Cannot delete admin user' });
    }
    
    // Find user by employeeId
    let userToDelete = null;
    for (const [username, user] of users.entries()) {
        if (user.employeeId === employeeId) {
            userToDelete = username;
            break;
        }
    }
    
    if (!userToDelete) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    const success = await deleteUserFromDB(userToDelete);
    
    if (!success) {
        return res.status(500).json({ error: 'Failed to delete user' });
    }
    
    console.log(`👤 User deleted: ${userToDelete} (ID: ${employeeId})`);
    
    res.json({ success: true });
});
 
// Activity Upload
app.post('/api/activity', appAuth, (req, res) => {
    const { employeeId, timestamp, activity } = req.body;
    
    if (employeeId === undefined || !activity) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
 
    // Store agent info
    const agentKey = `agent_${employeeId}`;
    agents.set(agentKey, {
        employeeId,
        name: activity.employeeName || `Employee ${employeeId}`,
        lastActivity: activity,
        lastSeen: Date.now()
    });
 
    // Store activity history (keep last 100)
    if (!activities.has(employeeId)) {
        activities.set(employeeId, []);
    }
    const activityList = activities.get(employeeId);
    activityList.unshift({ 
        timestamp: timestamp || Date.now(), 
        activity 
    });
    if (activityList.length > 100) {
        activityList.length = 100;
    }
 
    // ✅ FIXED: Broadcast mit richtigem Format!
    broadcastToAdmins({
        type: 'activity',  // Dashboard erwartet 'activity'!
        employeeId,
        activity,
        timestamp: timestamp || Date.now()
    });
 
    res.json({ success: true });
});
 
// ✅ Screenshot Upload - FÜR BILDER!
app.post('/api/screenshots', appAuth, (req, res) => {
    const { employeeId, imageData, filename, timestamp } = req.body;
    
    console.log('📸 Screenshot received from employee:', employeeId);
    
    if (!screenshots.has(employeeId)) {
        screenshots.set(employeeId, []);
    }
    
    const screenshotList = screenshots.get(employeeId);
    screenshotList.unshift({
        imageData,          // Das Base64-Bild!
        filename,
        timestamp: timestamp || Date.now()
    });
    
    // Keep only last 100 (wird auch durch Auto-Cleanup begrenzt)
    if (screenshotList.length > MAX_ITEMS_PER_EMPLOYEE) {
        screenshotList.length = MAX_ITEMS_PER_EMPLOYEE;
    }
    
    // Broadcast to admins
    broadcastToAdmins({
        type: 'screenshot',
        employeeId,
        data: {
            imageData,
            filename,
            timestamp: timestamp || Date.now()
        }
    });
    
    res.json({ success: true });
});
 
// Alerts - für Downloads UND User-Screenshots!
app.post('/api/alerts', appAuth, (req, res) => {
    const { type, data, timestamp, employeeId } = req.body;
 
    console.log('🚨 Alert received:', type, 'from employee:', employeeId);
 
    // ✅ User-Screenshots (vom Snipping Tool etc.)
    if (type === 'user_screenshot' && data && data.filename) {
        if (!screenshots.has(employeeId)) {
            screenshots.set(employeeId, []);
        }
        const screenshotList = screenshots.get(employeeId);
        screenshotList.unshift({
            filename: data.filename,
            filesize: data.filesize || 0,
            timestamp: data.timestamp || timestamp || Date.now(),
            type: 'user_screenshot'
        });
        if (screenshotList.length > 100) {
            screenshotList.length = 100;
        }
 
        // Broadcast to Dashboard
        broadcastToAdmins({
            type: 'screenshot',  // Dashboard erwartet 'screenshot'!
            employeeId,
            data: {
                filename: data.filename,
                filesize: data.filesize || 0,
                timestamp: data.timestamp || timestamp || Date.now()
            }
        });
    }
    // ✅ Echte Downloads
    else if (type === 'download_detected' && data && data.filename) {
        if (!downloads.has(employeeId)) {
            downloads.set(employeeId, []);
        }
        const downloadList = downloads.get(employeeId);
        downloadList.unshift({
            filename: data.filename,
            filesize: data.filesize || 0,
            timestamp: data.timestamp || timestamp || Date.now()
        });
        if (downloadList.length > 100) {
            downloadList.length = 100;
        }
 
        // Broadcast to Dashboard
        broadcastToAdmins({
            type: 'download_detected',
            employeeId,
            data: {
                filename: data.filename,
                filesize: data.filesize || 0,
                timestamp: data.timestamp || timestamp || Date.now()
            }
        });
    } 
    // ✅ Andere Alerts
    else {
        broadcastToAdmins({
            type: 'alert',
            alert: {
                type,
                data,
                timestamp: timestamp || Date.now(),
                employeeId
            }
        });
    }
 
    res.json({ success: true });
});
 
// Ping (keep-alive)
app.post('/api/ping', appAuth, (req, res) => {
    const { employeeId, timestamp, version } = req.body;
    
    if (employeeId) {
        const agentKey = `agent_${employeeId}`;
        if (agents.has(agentKey)) {
            agents.get(agentKey).lastSeen = Date.now();
        }
    }
    
    res.json({ success: true });
});
 
// ============================================
// 🔧 FIXED GET ENDPOINTS - Jetzt mit richtigem Format!
// ============================================
 
// Get Screenshots for employee
app.get('/api/screenshots/:employeeId', (req, res) => {
    const employeeId = parseInt(req.params.employeeId);
    const employeeScreenshots = screenshots.get(employeeId) || [];
    
    console.log(`📸 GET /api/screenshots/${employeeId} - Returning ${employeeScreenshots.length} screenshots`);
    
    // ✅ FIXED: Wrap in object with 'screenshots' property
    res.json({ 
        success: true,
        screenshots: employeeScreenshots 
    });
});
 
// Get Activities for employee
app.get('/api/activities/:employeeId', (req, res) => {
    const employeeId = parseInt(req.params.employeeId);
    const employeeActivities = activities.get(employeeId) || [];
    
    // ✅ Transform to match dashboard expectations
    const transformedActivities = employeeActivities.map(item => ({
        appName: item.activity?.application || 'Unknown',
        windowTitle: item.activity?.windowTitle || '',
        timestamp: item.activity?.timestamp || item.timestamp
    }));
    
    console.log(`📊 GET /api/activities/${employeeId} - Returning ${transformedActivities.length} activities`);
    
    // ✅ FIXED: Wrap in object with 'activities' property
    res.json({ 
        success: true,
        activities: transformedActivities 
    });
});
 
// ═══════════════════════════════════════════════════════════════════
// CREATOR PROFILES API
// ═══════════════════════════════════════════════════════════════════

// App token middleware — protects profile data from public scraping
function appAuth(req, res, next) {
    const token = req.headers['x-app-token'];
    const appToken = process.env.APP_TOKEN;
    if (!appToken) {
        console.warn('⚠️  APP_TOKEN not set — profile endpoint is unprotected!');
        return next(); // allow through but warn
    }
    if (!token || token !== appToken) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// GET — app-token protected (chatters fetch via Electron app, token stays in main process)
app.get('/api/creator-profiles', appAuth, (req, res) => {
    const profiles = Array.from(creatorProfiles.values());
    res.json({ success: true, profiles });
});

// POST — admin only: create new profile
app.post('/api/admin/creator-profiles', adminAuth, async (req, res) => {
    const { name, age, personality, style, interests, preferences, avoid_topics } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const profile = {
        id: Date.now().toString(),
        name, age: age || null,
        personality: personality || null,
        style: style || null,
        interests: interests || null,
        preferences: preferences || null,
        avoid_topics: avoid_topics || null,
        created_at: new Date().toISOString(),
        updated_at: null
    };

    const saved = await saveCreatorProfile(profile);
    if (!saved) return res.status(500).json({ error: 'Failed to save' });
    console.log(`✅ Creator profile created: ${name}`);
    res.json({ success: true, profile: saved });
});

// PUT — admin only: update existing profile
app.put('/api/admin/creator-profiles/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    if (!creatorProfiles.has(id)) return res.status(404).json({ error: 'Profile not found' });

    const existing = creatorProfiles.get(id);
    const updated = { ...existing, ...req.body, id, updated_at: new Date().toISOString() };

    const saved = await saveCreatorProfile(updated);
    if (!saved) return res.status(500).json({ error: 'Failed to save' });
    console.log(`✅ Creator profile updated: ${updated.name}`);
    res.json({ success: true, profile: saved });
});

// DELETE — admin only
app.delete('/api/admin/creator-profiles/:id', adminAuth, async (req, res) => {
    const { id } = req.params;
    if (!creatorProfiles.has(id)) return res.status(404).json({ error: 'Profile not found' });

    const success = await deleteCreatorProfile(id);
    if (!success) return res.status(500).json({ error: 'Failed to delete' });
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// TRANSLATIONS API (NEW!)
// ═══════════════════════════════════════════════════════════════════
 
const translations = new Map();

// DeepL Proxy — key stays in Railway env, never in the client binary
// lang is the source language of `text` (de/es/it); defaults to DE for
// older overlay builds that don't send it yet.
const DEEPL_SOURCE_LANG = { de: 'DE', es: 'ES', it: 'IT' };
app.post('/api/deepl', appAuth, async (req, res) => {
    const { text, lang } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const deepLKey = process.env.DEEPL_KEY;
    if (!deepLKey) return res.status(500).json({ error: 'DeepL not configured' });

    const sourceLang = DEEPL_SOURCE_LANG[lang] || 'DE';
    const https = require('https');
    const body = new URLSearchParams({ text, source_lang: sourceLang, target_lang: 'EN-US' }).toString();

    const tryEndpoint = (host, cb) => {
        const reqOpts = {
            hostname: host, path: '/v2/translate', method: 'POST',
            headers: {
                'Authorization': 'DeepL-Auth-Key ' + deepLKey,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const r = https.request(reqOpts, (resp) => {
            let data = '';
            resp.on('data', d => data += d);
            resp.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.translations && parsed.translations[0]) cb(null, parsed.translations[0].text);
                    else cb(new Error('DeepL error'));
                } catch(e) { cb(e); }
            });
        });
        r.on('error', cb);
        r.write(body);
        r.end();
    };

    tryEndpoint('api.deepl.com', (err, result) => {
        if (!err) return res.json({ ok: true, text: result });
        tryEndpoint('api-free.deepl.com', (err2, result2) => {
            if (!err2) return res.json({ ok: true, text: result2 });
            res.status(502).json({ ok: false, error: err.message });
        });
    });
});

// POST Translation
app.post('/api/translations', (req, res) => {
    const { employeeId, employeeName, timestamp, translation } = req.body;
    
    if (employeeId === undefined || !translation) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Store translation history (keep last 100)
    if (!translations.has(employeeId)) {
        translations.set(employeeId, []);
    }
    const translationList = translations.get(employeeId);
    translationList.unshift({ 
        timestamp: timestamp || Date.now(), 
        employeeName,
        translation 
    });
    if (translationList.length > 100) {
        translationList.length = 100;
    }
    
    console.log(`💬 Translation logged for employee ${employeeId}`);
    
    // Broadcast to admins
    broadcastToAdmins({
        type: 'translation',
        employeeId,
        employeeName,
        translation,
        timestamp: timestamp || Date.now()
    });
    
    res.json({ success: true });
});
 
// GET Translations for employee
app.get('/api/translations/:employeeId', (req, res) => {
    const employeeId = parseInt(req.params.employeeId);
    const employeeTranslations = translations.get(employeeId) || [];
    
    console.log(`📊 GET /api/translations/${employeeId} - Returning ${employeeTranslations.length} translations`);
    
    res.json({ 
        success: true,
        translations: employeeTranslations 
    });
});
 
// Get Downloads for employee
app.get('/api/downloads/:employeeId', (req, res) => {
    const employeeId = parseInt(req.params.employeeId);
    const employeeDownloads = downloads.get(employeeId) || [];
    
    console.log(`📥 GET /api/downloads/${employeeId} - Returning ${employeeDownloads.length} downloads`);
    
    // ✅ FIXED: Wrap in object with 'downloads' property
    res.json({ 
        success: true,
        downloads: employeeDownloads 
    });
});
 
// Get all agents
app.get('/api/agents', (req, res) => {
    const now = Date.now();
    const agentsList = Array.from(agents.values()).map(agent => ({
        employeeId: agent.employeeId,
        name: agent.name,
        lastSeen: agent.lastSeen,
        status: now - agent.lastSeen < 120000 ? 'online' : 'offline',
        lastActivity: agent.lastActivity
    }));
    res.json(agentsList);
});
 
// ============================================
// ✅ NEW ENDPOINT: Get Employees (merged users + agents)
// ============================================
app.get('/api/employees', adminAuth, (req, res) => {
    const now = Date.now();
    
    // Combine users with agent status
    const employeeList = Array.from(users.values())
        .filter(u => u.role === 'employee')
        .map(u => {
            const agentKey = `agent_${u.employeeId}`;
            const agent = agents.get(agentKey);
            
            return {
                id: u.employeeId,
                employeeId: u.employeeId,
                name: u.name || u.username,
                username: u.username,
                online: agent ? (now - agent.lastSeen < 120000) : false,
                lastSeen: agent ? agent.lastSeen : null,
                lastActivity: agent ? agent.lastActivity : null,
                createdAt: u.createdAt
            };
        });
    
    res.json({ employees: employeeList });
});
 
// ============================================
// 📊 DASHBOARD ROUTE (explicit for Railway)
// ============================================
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});
 
// ============================================
// WEBSOCKET
// ============================================
 
wss.on('connection', (ws, req) => {
    console.log('📡 New WebSocket connection');
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const role = url.searchParams.get('role');
    const employeeId = url.searchParams.get('employeeId');
 
    if (role === 'admin') {
        // Admin connection
        admins.add(ws);
        console.log('👨‍💼 Admin connected. Total admins:', admins.size);
 
        // Send current agents list
        const now = Date.now();
        const agentsList = Array.from(agents.values()).map(agent => ({
            employeeId: agent.employeeId,
            name: agent.name,
            lastSeen: agent.lastSeen,
            status: now - agent.lastSeen < 120000 ? 'online' : 'offline',
            lastActivity: agent.lastActivity
        }));
 
        ws.send(JSON.stringify({
            type: 'agents_list',
            agents: agentsList
        }));
 
        ws.on('close', () => {
            admins.delete(ws);
            console.log('👨‍💼 Admin disconnected. Total admins:', admins.size);
        });
 
        ws.on('error', (error) => {
            console.error('Admin WebSocket error:', error.message);
        });
    } else {
        // Regular connection (no role specified)
        // Still add to admins for backward compatibility
        admins.add(ws);
        console.log('📡 Client connected (no role). Total clients:', admins.size);
 
        ws.on('close', () => {
            admins.delete(ws);
            console.log('📡 Client disconnected. Total clients:', admins.size);
        });
    }
 
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received message type:', data.type);
            
            // ✅ Handle register_admin message
            if (data.type === 'register_admin') {
                admins.add(ws);
                console.log('👨‍💼 Admin registered via message. Total admins:', admins.size);
                
                // Send initial state
                ws.send(JSON.stringify({
                    type: 'initial_state',
                    employees: Array.from(agents.values()),
                    activities: Object.fromEntries(activities),
                    screenshots: Object.fromEntries(screenshots),
                    downloads: Object.fromEntries(downloads)
                }));
                
                // Setup close handler
                ws.on('close', () => {
                    admins.delete(ws);
                    console.log('👨‍💼 Admin disconnected. Total admins:', admins.size);
                });
            }
        } catch (error) {
            console.error('Message parse error:', error.message);
        }
    });
});
 
function broadcastToAdmins(message) {
    let sent = 0;
    admins.forEach(admin => {
        if (admin.readyState === WebSocket.OPEN) {
            try {
                admin.send(JSON.stringify(message));
                sent++;
            } catch (error) {
                console.error('Broadcast error:', error.message);
            }
        }
    });
    if (sent > 0) {
        console.log(`📤 Broadcast to ${sent} client(s): ${message.type}`);
    }
}
 
// ============================================
// CLEANUP & MAINTENANCE
// ============================================
 
// Cleanup old inactive agents every 5 minutes
setInterval(() => {
    const now = Date.now();
    const timeout = 300000; // 5 minutes
 
    for (const [key, agent] of agents.entries()) {
        if (now - agent.lastSeen > timeout) {
            agents.delete(key);
            console.log(`🗑️ Removed inactive agent: ${agent.employeeId} (${agent.name})`);
            
            // Notify admins
            broadcastToAdmins({
                type: 'agent_disconnected',
                employeeId: agent.employeeId
            });
        }
    }
}, 300000);
 
// Memory cleanup every 30 minutes
setInterval(() => {
    // Cleanup old screenshots (keep only last 10)
    screenshots.forEach((list, employeeId) => {
        if (list.length > 10) {
            list.length = 10;
        }
    });
 
    // Cleanup old activities (keep only last 100)
    activities.forEach((list, employeeId) => {
        if (list.length > 100) {
            list.length = 100;
        }
    });
 
    // Cleanup old downloads (keep only last 100)
    downloads.forEach((list, employeeId) => {
        if (list.length > 100) {
            list.length = 100;
        }
    });
 
    console.log('🧹 Memory cleanup completed');
}, 1800000);
 
// ============================================
// SERVER START
// ============================================
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🎉 ==========================================');
    console.log('🎉  Monitoring Relay Server ONLINE!');
    console.log('🎉 ==========================================');
    console.log('');
    console.log(`📊 Server: http://localhost:${PORT}`);
    console.log(`🔗 Health: http://localhost:${PORT}/health`);
    console.log(`🔗 API:    http://localhost:${PORT}/api`);
    console.log('');
    console.log('💡 Ready to receive connections from agents');
    console.log('💡 Dashboard can connect via WebSocket');
    console.log('');
});
 
// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
 
process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});
