const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Data Stores
const users = {}; // username -> { username, password, displayName, ptmAvatar, isCEO }
const activeSockets = {}; // socket.id -> username
const servers = {
    'general-server': {
        id: 'general-server',
        name: 'Public Community',
        channels: ['general', 'random'],
        members: {}, // username -> role
        messages: { 'general': [], 'random': [] }
    }
};

let serverShutdown = false;

// Pre-create CEO Account "iwot"
users['iwot'] = {
    username: 'iwot',
    password: 'boxedbytr1zl1',
    displayName: 'iwot',
    avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=iwot',
    isCEO: true
};

io.on('connection', (socket) => {
    if (serverShutdown) {
        socket.emit('error_msg', 'Server is currently shut down by CEO.');
        socket.disconnect();
        return;
    }

    // Register / Login
    socket.on('auth_login', ({ username, password, displayName, avatar }) => {
        const lowerName = username.trim().toLowerCase();
        
        if (users[lowerName]) {
            if (users[lowerName].password !== password) {
                return socket.emit('auth_result', { success: false, message: 'Invalid password.' });
            }
        } else {
            // Register new user
            users[lowerName] = {
                username: lowerName,
                password: password,
                displayName: displayName || username,
                avatar: avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${lowerName}`,
                isCEO: lowerName === 'iwot'
            };
        }

        const user = users[lowerName];
        if (user.banned) {
            return socket.emit('auth_result', { success: false, message: 'Your account has been banned by an admin.' });
        }

        activeSockets[socket.id] = lowerName;
        socket.emit('auth_result', { success: true, user });

        // Auto join general server
        servers['general-server'].members[lowerName] = user.isCEO ? 'iwot [CEO]' : 'Member';
        socket.join('general-server');
        
        io.emit('server_list_update', getPublicServers());
    });

    // Profile Update
    socket.on('update_profile', ({ displayName, avatar }) => {
        const username = activeSockets[socket.id];
        if (!username || !users[username]) return;
        
        users[username].displayName = displayName;
        if (avatar) users[username].avatar = avatar;
        
        socket.emit('profile_updated', users[username]);
    });

    // Create Server
    socket.on('create_server', ({ name }) => {
        const username = activeSockets[socket.id];
        if (!username) return;

        const serverId = 'srv-' + Math.random().toString(36).substr(2, 9);
        const isCEO = users[username].isCEO;

        servers[serverId] = {
            id: serverId,
            name: name,
            channels: ['general', 'lounge'],
            members: { [username]: isCEO ? 'iwot [CEO]' : 'Owner' },
            messages: { 'general': [], 'lounge': [] }
        };

        // Ensure CEO is added as iwot [CEO] in all servers
        if (!isCEO && users['iwot']) {
            servers[serverId].members['iwot'] = 'iwot [CEO]';
        }

        socket.join(serverId);
        io.emit('server_list_update', getPublicServers());
        socket.emit('server_created', servers[serverId]);
    });

    // Join Server
    socket.on('join_server', (serverId) => {
        const username = activeSockets[socket.id];
        if (!username || !servers[serverId]) return;

        const isCEO = users[username].isCEO;
        if (!servers[serverId].members[username]) {
            servers[serverId].members[username] = isCEO ? 'iwot [CEO]' : 'Member';
        }

        socket.join(serverId);
        socket.emit('server_data', servers[serverId]);
    });

    // Send Message
    socket.on('send_message', ({ serverId, channelId, text }) => {
        const username = activeSockets[socket.id];
        if (!username || !servers[serverId]) return;

        const user = users[username];
        const role = servers[serverId].members[username] || 'Member';

        const msgObj = {
            id: 'msg-' + Date.now(),
            author: user.displayName,
            username: user.username,
            avatar: user.avatar,
            role: user.isCEO ? 'iwot [CEO]' : role,
            text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        if (!servers[serverId].messages[channelId]) {
            servers[serverId].messages[channelId] = [];
        }
        servers[serverId].messages[channelId].push(msgObj);

        io.to(serverId).emit('new_message', { serverId, channelId, message: msgObj });
    });

    // CEO Admin: Ban User
    socket.on('admin_ban_user', (targetUsername) => {
        const username = activeSockets[socket.id];
        if (!username || !users[username].isCEO) return;

        const target = targetUsername.toLowerCase();
        if (users[target]) {
            users[target].banned = true;
            
            // Disconnect target sockets
            for (let [sId, uName] of Object.entries(activeSockets)) {
                if (uName === target) {
                    io.sockets.sockets.get(sId)?.emit('error_msg', 'You have been banned by the CEO.');
                    io.sockets.sockets.get(sId)?.disconnect();
                }
            }
            socket.emit('admin_action_success', `Banned user ${target}`);
        }
    });

    // CEO Admin: Shutdown Server
    socket.on('admin_shutdown', () => {
        const username = activeSockets[socket.id];
        if (!username || !users[username].isCEO) return;

        serverShutdown = true;
        io.emit('error_msg', 'Server shutting down by CEO order...');
        io.disconnectSockets();
    });
});

function getPublicServers() {
    return Object.values(servers).map(s => ({
        id: s.id,
        name: s.name,
        memberCount: Object.keys(s.members).length
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
