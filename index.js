const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: './22k.env' });

// --- DISCORD BOT INICIALIZÁLÁS ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const recentJoins = new Map();
const lockedChannelsMap = new Map();

// Perzisztens Audit Log kezelés (Fájl alapú mentés)
const LOGS_FILE = path.join(__dirname, 'audit_logs.json');

function loadAuditLogs() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            const data = fs.readFileSync(LOGS_FILE, 'utf8');
            const parsed = JSON.parse(data);
            const map = new Map();
            for (const [guildId, logs] of Object.entries(parsed)) {
                map.set(guildId, logs);
            }
            return map;
        }
    } catch (err) {
        console.error('Failed to load audit logs from file:', err);
    }
    return new Map();
}

function saveAuditLogs() {
    try {
        const obj = {};
        for (const [guildId, logs] of auditLogsMap.entries()) {
            obj[guildId] = logs;
        }
        fs.writeFileSync(LOGS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save audit logs to file:', err);
    }
}

const auditLogsMap = loadAuditLogs();

async function sendLog(guild, embed) {
    try {
        if (!auditLogsMap.has(guild.id)) {
            auditLogsMap.set(guild.id, []);
        }
        auditLogsMap.get(guild.id).unshift({
            title: embed.data.title || 'Log Entry',
            description: embed.data.description || '',
            color: embed.data.color ? `#${embed.data.color.toString(16).padStart(6, '0')}` : '#6366f1',
            timestamp: new Date().toISOString()
        });
        
        saveAuditLogs();

        const logChannel = guild.channels.cache.find(c => c.name === '22k-shield-logs');
        if (logChannel) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error('Failed to send log message:', err);
    }
}

client.once('clientReady', async () => {
    console.log(`[22K Shield] Logged in as ${client.user.tag}!`);

    const commands = [
        new SlashCommandBuilder()
            .setName('setup')
            .setDescription('Configures default security settings and creates audit log channel.')
            .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
        new SlashCommandBuilder()
            .setName('lockdown')
            .setDescription('Instantly locks down or unlocks the server in case of emergency.')
            .addStringOption(option =>
                option.setName('status')
                    .setDescription('Choose whether to turn lockdown on or off')
                    .setRequired(true)
                    .addChoices(
                        { name: 'On (Lock server)', value: 'on' },
                        { name: 'Off (Unlock server)', value: 'off' }
                    ))
            .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
        new SlashCommandBuilder()
            .setName('settings')
            .setDescription('Displays current security configuration.'),
        new SlashCommandBuilder()
            .setName('help')
            .setDescription('Shows help information and command guide.'),
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );
        console.log('[22K Shield] Slash commands reloaded.');
    } catch (error) {
        console.error(error);
    }
});

// Anti-Raid
client.on('guildMemberAdd', async (member) => {
    const guildId = member.guild.id;
    const now = Date.now();
    if (!recentJoins.has(guildId)) recentJoins.set(guildId, []);
    const timestamps = recentJoins.get(guildId);
    timestamps.push(now);
    const validJoins = timestamps.filter(t => now - t < 10000);
    recentJoins.set(guildId, validJoins);

    if (validJoins.length > 5) {
        try {
            const channels = member.guild.channels.cache.filter(c => c.isTextBased());
            const alertChannel = channels.first();
            const embed = new EmbedBuilder()
                .setTitle('🚨 RAID DETECTED / AUTOMATIC ALERT')
                .setDescription('Unusual mass join activity detected! 22K Shield has temporarily stepped in to protect the community.')
                .setColor('#ef4444')
                .setTimestamp();
            if (alertChannel) await alertChannel.send({ embeds: [embed] });
            await sendLog(member.guild, embed);
        } catch (err) {
            console.error('Error during anti-raid trigger:', err);
        }
    }
});

// Link szűrés
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const content = message.content.toLowerCase();
    if (content.includes('discord.gg/') || content.includes('t.me/') || content.includes('http://') || content.includes('https://')) {
        try {
            await message.delete();
            const warning = await message.channel.send(`⚠️ <@${message.author.id}>, links and advertisements are not allowed! Protected by **22K Shield**.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) {
            console.error('Failed to delete spam message:', err);
        }
    }
});

// Slash parancsok
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'setup') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        }
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const guild = interaction.guild;
            let logChannel = guild.channels.cache.find(c => c.name === '22k-shield-logs');
            if (!logChannel) {
                logChannel = await guild.channels.create({
                    name: '22k-shield-logs',
                    type: 0,
                    topic: 'Audit log channel for 22K Shield.',
                    permissionOverwrites: [
                        { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
                    ]
                });
            }
            const embed = new EmbedBuilder()
                .setTitle('⚙️ 22K Shield Setup Completed')
                .setDescription(`Initialized by **${interaction.user.tag}**.`)
                .setColor('#6366f1')
                .addFields({ name: 'Audit Log Channel', value: `<#${logChannel.id}>`, inline: true })
                .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
            await logChannel.send({ embeds: [embed] }).catch(() => {});
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ Error during setup.');
        }
    } else if (commandName === 'settings') {
        const embed = new EmbedBuilder()
            .setTitle('🛡️ 22K Shield - Security Settings')
            .setColor('#6366f1')
            .addFields(
                { name: 'Anti-Raid Protection', value: '`ACTIVE`', inline: false },
                { name: 'Link Filter', value: '`ACTIVE`', inline: true }
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    } else if (commandName === 'help') {
        await interaction.reply({ content: '📖 Use dashboard or `/setup`, `/lockdown` commands.', flags: [MessageFlags.Ephemeral] });
    }
});


// --- EXPRESS DASHBOARD WEBSZERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: '22k_shield_super_secret_key',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: 'https://db.22krishi.site/auth/discord/callback',
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/'
}), (req, res) => {
    res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// A saját 22K Shield weboldal design sablonunk
const baseStyles = `
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 0; }
    .container { max-width: 900px; margin: 40px auto; padding: 30px; background: #1e293b; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.4); border: 1px solid #334155; }
    h1, h2, h3 { color: #f1f5f9; }
    hr { border: 0; height: 1px; background: #334155; margin: 20px 0; }
    .btn { display: inline-block; padding: 10px 20px; font-weight: 600; text-decoration: none; border-radius: 6px; transition: 0.2s; border: none; cursor: pointer; text-align: center; }
    .btn-primary { background-color: #6366f1; color: white; }
    .btn-primary:hover { background-color: #4f46e5; }
    .btn-success { background-color: #22c55e; color: white; }
    .btn-success:hover { background-color: #16a34a; }
    .btn-danger { background-color: #ef4444; color: white; }
    .btn-danger:hover { background-color: #dc2626; }
    .btn-secondary { background-color: #475569; color: white; }
    .btn-secondary:hover { background-color: #334155; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 15px; margin-top: 15px; }
    .card { background: #0f172a; padding: 15px 20px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid #334155; }
    .server-info { display: flex; align-items: center; gap: 15px; }
    .server-icon { width: 45px; height: 45px; border-radius: 50%; background: #334155; display: flex; align-items: center; justify-content: center; font-weight: bold; overflow: hidden; color: white; }
    .server-icon img { width: 100%; height: 100%; object-fit: cover; }
    .badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; }
    .badge-green { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .badge-gray { background: rgba(148, 163, 184, 0.15); color: #94a3b8; }
    .nav-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
`;

// Főoldal (Landing page a saját 22K designnal)
app.get('/', (req, res) => {
    res.send(`
        <style>${baseStyles}</style>
        <div class="container" style="text-align: center; margin-top: 100px; max-width: 500px;">
            <div style="font-size: 60px; margin-bottom: 10px;">🛡️</div>
            <h1>22K Shield Dashboard</h1>
            <p style="color: #94a3b8; margin-bottom: 30px;">Advanced Discord server protection and emergency lockdown control.</p>
            ${req.isAuthenticated() 
                ? '<a href="/dashboard" class="btn btn-primary" style="font-size: 16px; padding: 12px 30px;">Go to Dashboard</a>' 
                : '<a href="/auth/discord" class="btn btn-primary" style="font-size: 16px; padding: 12px 30px; background-color: #5865F2;">Login with Discord</a>'}
        </div>
    `);
});

// Fő Dashboard oldal (Aktív és Elérhető szerverek kategóriákra szedve a saját designnal)
app.get('/dashboard', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);

    let activeHtml = '';
    let availableHtml = '';

    adminGuilds.forEach(g => {
        const botIsInServer = client.guilds.cache.has(g.id);
        const iconUrl = g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null;
        const initials = g.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

        const cardContent = `
            <div class="card">
                <div class="server-info">
                    <div class="server-icon">
                        ${iconUrl ? `<img src="${iconUrl}" alt="${g.name}">` : initials}
                    </div>
                    <div>
                        <strong style="font-size: 16px; display: block; margin-bottom: 3px;">${g.name}</strong>
                        ${botIsInServer ? '<span class="badge badge-green">Active (Bot Connected)</span>' : '<span class="badge badge-gray">Not Installed</span>'}
                    </div>
                </div>
                <div>
                    ${botIsInServer 
                        ? `<a href="/dashboard/${g.id}" class="btn btn-primary">Manage</a>` 
                        : `<a href="https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot%20applications.commands&guild_id=${g.id}" target="_blank" class="btn btn-success">Add Bot</a>`}
                </div>
            </div>
        `;

        if (botIsInServer) {
            activeHtml += cardContent;
        } else {
            availableHtml += cardContent;
        }
    });

    res.send(`
        <style>${baseStyles}</style>
        <div class="container">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h2 style="margin: 0;">Welcome, ${req.user.username}</h2>
                    <p style="color: #94a3b8; margin: 3px 0 0 0; font-size: 14px;">Select a server to manage security settings.</p>
                </div>
                <a href="/logout" class="btn btn-danger" style="padding: 8px 15px; font-size: 14px;">Logout</a>
            </div>
            
            <hr>

            <h3 style="color: #22c55e; margin-top: 30px;">🟢 Active Servers (Bot Connected)</h3>
            <div class="grid">
                ${activeHtml || '<p style="color: #64748b; font-style: italic;">No active servers found where you are an admin.</p>'}
            </div>

            <h3 style="color: #94a3b8; margin-top: 40px;">⚪ Available Servers (Bot Not Installed)</h3>
            <div class="grid">
                ${availableHtml || '<p style="color: #64748b; font-style: italic;">No available servers found.</p>'}
            </div>
        </div>
    `);
});

// Egyedi szerver vezérlőpultja (Áttekintés)
app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    const userGuild = adminGuilds.find(g => g.id === guildId);
    if (!userGuild) return res.send('Access Denied or Server not found.');

    let guild = client.guilds.cache.get(guildId);
    const botIsInServer = !!guild;

    const guildLockedSet = lockedChannelsMap.get(guildId);
    const isLocked = guildLockedSet && guildLockedSet.size > 0;

    res.send(`
        <style>${baseStyles}</style>
        <div class="container" style="max-width: 700px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <a href="/dashboard" class="btn btn-secondary" style="font-size: 14px; padding: 6px 12px;">&larr; Back to Servers</a>
                <a href="/logout" class="btn btn-danger" style="font-size: 14px; padding: 6px 12px;">Logout</a>
            </div>

            <!-- Menü fülek -->
            <div class="nav-tabs">
                <a href="/dashboard/${guildId}" class="btn btn-primary" style="flex: 1; font-size: 14px;">📊 Overview</a>
                <a href="/dashboard/${guildId}/security-filters" class="btn btn-secondary" style="flex: 1; font-size: 14px;">⚙️ Security Filters</a>
                <a href="/dashboard/${guildId}/audit-logs" class="btn btn-secondary" style="flex: 1; font-size: 14px;">📜 Audit Logs</a>
            </div>
            
            <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 20px;">
                <div class="server-icon" style="width: 60px; height: 60px; font-size: 20px;">
                    ${userGuild.icon ? `<img src="https://cdn.discordapp.com/icons/${userGuild.id}/${userGuild.icon}.png">` : userGuild.name[0]}
                </div>
                <div>
                    <h2 style="margin: 0;">${userGuild.name}</h2>
                    <span class="badge ${isLocked ? 'badge-red' : 'badge-green'}" style="margin-top: 5px; display: inline-block;">
                        ${isLocked ? '🔒 Status: Locked Down' : '🛡️ Status: Protected & Normal'}
                    </span>
                </div>
            </div>

            <hr>

            <div style="background: #0f172a; padding: 25px; border-radius: 8px; border: 1px solid #334155; margin-top: 20px;">
                <h3 style="margin-top: 0; color: ${isLocked ? '#ef4444' : '#6366f1'};">🚨 Emergency Lockdown Control</h3>
                <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">
                    ${isLocked 
                        ? 'The server is currently under lockdown. Regular members cannot send messages in locked text channels.' 
                        : 'Instantly restrict message permissions for all regular members across eligible channels in case of an emergency.'}
                </p>
                ${botIsInServer ? `
                    <form action="/api/lockdown/${guildId}" method="POST">
                        ${isLocked 
                            ? '<button type="submit" name="status" value="off" class="btn btn-success" style="width: 100%; padding: 12px; font-size: 15px;">LIFT LOCKDOWN (UNLOCK SERVER)</button>' 
                            : '<button type="submit" name="status" value="on" class="btn btn-danger" style="width: 100%; padding: 12px; font-size: 15px;">ENABLE LOCKDOWN (LOCK SERVER)</button>'}
                    </form>
                ` : `
                    <p style="color: #ef4444; font-weight: bold; margin-bottom: 15px;">The bot is not in this server, so it cannot be controlled!</p>
                    <a href="https://discord.com/api/oauth2/authorize?client_id=${process.env.CLIENT_ID}&permissions=8&scope=bot%20applications.commands&guild_id=${guildId}" target="_blank" class="btn btn-success" style="width: 100%; padding: 12px; text-align: center;">Add Bot to Server</a>
                `}
            </div>
        </div>
    `);
});

// Security Filters oldal
app.get('/dashboard/:guildId/security-filters', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    const userGuild = adminGuilds.find(g => g.id === guildId);
    if (!userGuild) return res.send('Access Denied.');

    res.send(`
        <style>${baseStyles}</style>
        <div class="container" style="max-width: 700px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <a href="/dashboard" class="btn btn-secondary" style="font-size: 14px; padding: 6px 12px;">&larr; Back to Servers</a>
                <a href="/logout" class="btn btn-danger" style="font-size: 14px; padding: 6px 12px;">Logout</a>
            </div>

            <div class="nav-tabs">
                <a href="/dashboard/${guildId}" class="btn btn-secondary" style="flex: 1; font-size: 14px;">📊 Overview</a>
                <a href="/dashboard/${guildId}/security-filters" class="btn btn-primary" style="flex: 1; font-size: 14px;">⚙️ Security Filters</a>
                <a href="/dashboard/${guildId}/audit-logs" class="btn btn-secondary" style="flex: 1; font-size: 14px;">📜 Audit Logs</a>
            </div>

            <div style="background: #0f172a; padding: 25px; border-radius: 8px; border: 1px solid #334155; margin-top: 20px;">
                <h3 style="margin-top: 0; color: #f1f5f9;">⚙️ Active Protection Modules</h3>
                <p style="color: #94a3b8; font-size: 14px;">Anti-raid protection and link filtering features are fully active by default.</p>
            </div>
        </div>
    `);
});

// Audit Logs oldal (Perzisztens mentéssel)
app.get('/dashboard/:guildId/audit-logs', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    const userGuild = adminGuilds.find(g => g.id === guildId);
    if (!userGuild) return res.send('Access Denied.');

    const logs = auditLogsMap.get(guildId) || [];

    let logsHtml = logs.length === 0 
        ? '<p style="color: #64748b; font-style: italic;">No audit logs recorded yet.</p>' 
        : logs.map(l => `
            <div style="background: #1e293b; padding: 15px; border-radius: 6px; border-left: 4px solid ${l.color}; margin-bottom: 10px; border: 1px solid #334155;">
                <div style="font-weight: bold; color: white; font-size: 14px; margin-bottom: 4px;">${l.title}</div>
                <div style="color: #94a3b8; font-size: 13px; margin-bottom: 6px;">${l.description}</div>
                <div style="color: #64748b; font-size: 11px;">${new Date(l.timestamp).toLocaleString()}</div>
            </div>
        `).join('');

    res.send(`
        <style>${baseStyles}</style>
        <div class="container" style="max-width: 700px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <a href="/dashboard" class="btn btn-secondary" style="font-size: 14px; padding: 6px 12px;">&larr; Back to Servers</a>
                <a href="/logout" class="btn btn-danger" style="font-size: 14px; padding: 6px 12px;">Logout</a>
            </div>

            <div class="nav-tabs">
                <a href="/dashboard/${guildId}" class="btn btn-secondary" style="flex: 1; font-size: 14px;">📊 Overview</a>
                <a href="/dashboard/${guildId}/security-filters" class="btn btn-secondary" style="flex: 1; font-size: 14px;">⚙️ Security Filters</a>
                <a href="/dashboard/${guildId}/audit-logs" class="btn btn-primary" style="flex: 1; font-size: 14px;">📜 Audit Logs</a>
            </div>

            <div style="background: #0f172a; padding: 25px; border-radius: 8px; border: 1px solid #334155; margin-top: 20px;">
                <h3 style="margin-top: 0; color: #f1f5f9;">📜 Recent Security Events (Saved)</h3>
                <div style="margin-top: 15px;">
                    ${logsHtml}
                </div>
            </div>
        </div>
    `);
});

// Lockdown API végpont
app.post('/api/lockdown/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const status = req.body.status;

    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    const userGuild = adminGuilds.find(g => g.id === guildId);
    if (!userGuild) return res.status(403).send('Unauthorized');

    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
        try {
            guild = await client.guilds.fetch(guildId);
        } catch (err) {
            return res.send(`<script>alert('Error: Bot cannot access this server!'); window.location.href='/dashboard/${guildId}';</script>`);
        }
    }

    try {
        const fetchedChannels = await guild.channels.fetch();
        const everyoneRole = guild.roles.everyone;
        let processedCount = 0;
        const channels = fetchedChannels.filter(c => c && c.isTextBased());

        if (!lockedChannelsMap.has(guild.id)) {
            lockedChannelsMap.set(guild.id, new Set());
        }
        const guildLockedSet = lockedChannelsMap.get(guild.id);

        for (const [id, channel] of channels) {
            try {
                const overwrites = channel.permissionOverwrites.cache.get(everyoneRole.id);
                const isExplicitlyDenied = overwrites && overwrites.deny.has(PermissionsBitField.Flags.SendMessages);

                if (status === 'on') {
                    if (!isExplicitlyDenied) {
                        await channel.permissionOverwrites.edit(everyoneRole, { 
                            SendMessages: false 
                        }, { reason: 'Dashboard Emergency Lockdown ON' });
                        
                        guildLockedSet.add(id);
                        processedCount++;
                    }
                } else {
                    if (guildLockedSet.has(id)) {
                        await channel.permissionOverwrites.edit(everyoneRole, { 
                            SendMessages: null 
                        }, { reason: 'Dashboard Lockdown Lifted' });
                        
                        guildLockedSet.delete(id);
                        processedCount++;
                    }
                }
            } catch (channelErr) {
                console.error(`Skipped channel ${channel.name}:`, channelErr);
            }
        }

        const logEmbed = new EmbedBuilder().setTimestamp();
        if (status === 'on') {
            logEmbed.setTitle('🔒 EMERGENCY LOCKDOWN ACTIVATED (VIA WEB)').setDescription(`Locked **${processedCount}** channels.`).setColor('#ef4444');
        } else {
            logEmbed.setTitle('🔓 LOCKDOWN LIFTED (VIA WEB)').setDescription(`Restored **${processedCount}** channels.`).setColor('#22c55e');
        }
        await sendLog(guild, logEmbed);

        res.send(`
            <script>
                alert('Successfully executed lockdown: ${status.toUpperCase()} (${processedCount} channels affected)');
                window.location.href='/dashboard/${guildId}';
            </script>
        `);
    } catch (err) {
        console.error('Lockdown error:', err);
        res.status(500).send('Error processing lockdown.');
    }
});

// Web szerver indítása
app.listen(PORT, () => {
    console.log(`[22K Shield Web] Dashboard running at http://localhost:${PORT}`);
});

// --- DISCORD BOT LOGIN ---
client.login(process.env.DISCORD_TOKEN);
