const bcrypt = require('bcryptjs');
const HandleDatabase = require('./database');
const crypto = require('crypto');

// Rate Limits State (Memory-based, resets on restart)
const loginAttempts = {};

const Auth = {
    // Session Management
    createSession: async (username, userAgent = "", ip = "") => {
        const sessionId = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        await HandleDatabase.insertSession(sessionId, username, expires, userAgent, ip);
        return sessionId;
    },

    getUserSessions: async (username) => {
        const sessions = await HandleDatabase.getSessions(username);
        return sessions.map(s => {
            const parsed = Auth.parseUA(s.user_agent);
            return {
                id: s.id,
                browser: parsed.browser,
                os: parsed.os,
                ip: s.ip_address,
                created_at: s.created_at,
                expires: s.expires
            };
        });
    },

    parseUA: (ua) => {
        if (!ua) return { browser: "Unknown", os: "Unknown" };
        let browser = "Unknown Browser";
        let os = "Unknown OS";

        // Simple Browser Detection
        if (ua.includes("Firefox")) browser = "Firefox";
        else if (ua.includes("Edg")) browser = "Edge";
        else if (ua.includes("Chrome")) browser = "Chrome";
        else if (ua.includes("Safari")) browser = "Safari";

        // Simple OS Detection
        if (ua.includes("Windows")) os = "Windows";
        else if (ua.includes("Mac OS")) os = "macOS";
        else if (ua.includes("Linux")) os = "Linux";
        else if (ua.includes("Android")) os = "Android";
        else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";

        return { browser, os };
    },

    getSessionUser: async (sessionId) => {
        const session = await HandleDatabase.getSession(sessionId);
        if (session && session.expires > Date.now()) {
            return session.username;
        }
        if (session) await HandleDatabase.deleteSession(sessionId);
        return null;
    },

    removeSession: async (sessionId) => {
        await HandleDatabase.deleteSession(sessionId);
    },

    invalidateOtherSessions: async (username, currentSessionId) => {
        await HandleDatabase.deleteOtherSessions(username, currentSessionId);
    },

    invalidateAllSessions: async (username) => {
        await HandleDatabase.deleteAllSessions(username);
    },

    // Turnstile
    verifyTurnstile: async (token, ip) => {
        const secret = process.env.TURNSTILE_SECRET_KEY;
        if (!secret) {
            console.error("Turnstile Secret Key not found in environment variables.");
            return false;
        }

        const formData = new URLSearchParams();
        formData.append('secret', secret);
        formData.append('response', token);
        formData.append('remoteip', ip);

        try {
            const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            return data.success === true;
        } catch (err) {
            console.error("Turnstile verification error:", err);
            return false;
        }
    },

    // Login Limits
    isBlocked: (ip) => {
        const attempt = loginAttempts[ip];
        if (attempt && attempt.blockedUntil && attempt.blockedUntil > Date.now()) {
            return true;
        }
        return false;
    },

    addAttempt: (ip) => {
        if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0 };
        loginAttempts[ip].count++;

        if (loginAttempts[ip].count >= 8) { // After 8 attempts block
            loginAttempts[ip].blockedUntil = Date.now() + 15 * 60 * 1000; // 15 mins
            return true;
        }
        return false;
    },

    resetAttempts: (ip) => {
        delete loginAttempts[ip];
    },

    getAttempts: (ip) => {
        return loginAttempts[ip] ? loginAttempts[ip].count : 0;
    },

    // Password Checks
    hashPassword: (password) => {
        const salt = bcrypt.genSaltSync(10);
        return bcrypt.hashSync(password, salt);
    },

    comparePassword: (password, hash) => {
        return bcrypt.compareSync(password, hash);
    }
};

module.exports = Auth;
