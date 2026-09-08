require('dotenv').config();
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const ms = require('ms');

// ==========================================
// 1. CONFIG & SETTINGS
// ==========================================
const CONFIG = {
    GUILD_ID: '1436668953173688434',
    DEFAULT_PARENT: '1527688497593585746', 
    SORSOLAS_PARENTS: ['1534568444974862506', '1534631388211445891'],
    PARTNER_PARENTS: ['1534568268956827758'],
    REMINDER_CHANNEL: '1546794386581356584',
    REMINDER_ROLE: '1546794488372924476',
    BOOSTER_ROLE: '1449473778386997311',
    STAFF_ROLE: '1436671411178569832',
    MEMBER_ROLE: '1486847637134246139',
    CASINO_VAULT_USER: '1273195305013084200' // A játékosok által elbukott pénz ide kerül
};

// ==========================================
// 2. DATABASE & MODELS
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Adatbázis csatlakoztatva!'))
    .catch(err => console.error('❌ DB hiba:', err));

const User = mongoose.model('User', new mongoose.Schema({ 
    guildId: String, userId: String, 
    balance: { type: Number, default: 0 }, 
    lastTreasure: { type: Number, default: 0 },
    lastDaily: { type: Number, default: 0 },
    lastWork: { type: Number, default: 0 },
    // Új statisztika mezők
    stats: {
        blackjack: { played: { type: Number, default: 0 }, won: { type: Number, default: 0 }, netProfit: { type: Number, default: 0 } },
        mines: { played: { type: Number, default: 0 }, won: { type: Number, default: 0 }, netProfit: { type: Number, default: 0 } }
    }
}));
const Invite = mongoose.model('Invite', new mongoose.Schema({ guildId: String, userId: String, invites: Number }));
const Giveaway = mongoose.model('Giveaway', new mongoose.Schema({ messageId: String, channelId: String, guildId: String, endTime: Number, prize: String, winnerCount: Number, boosterBonus: Number, ended: { type: Boolean, default: false } }));

app.get('/', (req, res) => res.send('OK'));
app.listen(process.env.PORT || 3000);

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// MEMÓRIA TÁROLÓK
const activeMines = new Map();
const activeBlackjack = new Map();
const commandCooldowns = new Map();

// ==========================================
// 3. HELPER FUNCTIONS
// ==========================================
const formatFt = (amount) => new Intl.NumberFormat('hu-HU').format(amount) + ' Ft';
const getUserDb = async (guildId, userId) => await User.findOne({ guildId, userId }) || new User({ guildId, userId, balance: 0, lastTreasure: 0, lastDaily: 0, lastWork: 0 });

async function addLossToVault(guildId, amount) {
    if (amount <= 0) return;
    try {
        const vaultDb = await getUserDb(guildId, CONFIG.CASINO_VAULT_USER);
        vaultDb.balance += amount;
        await vaultDb.save();
    } catch (e) {
        console.error('❌ Hiba a kaszinó számla frissítésekor:', e);
    }
}

function drawWinners(participants, count) {
    const winners = [];
    let list = [...participants];
    for (let i = 0; i < count && list.length; i++) {
        const total = list.reduce((s, p) => s + p.weight, 0);
        let r = Math.random() * total;
        for (let j = 0; j < list.length; j++) {
            r -= list[j].weight;
            if (r <= 0) { winners.push(list[j].id); list.splice(j, 1); break; }
        }
    }
    return winners;
}

const updateStatus = (g) => g && client.user.setPresence({ activities: [{ name: `👥 ${g.memberCount} tag | /blackjack`, type: 4 }], status: 'online' });

// ==========================================
// 4. TICKET MANAGEMENT
// ==========================================
async function auditAndFixCategories(guild, categoryType) {
    if (categoryType === 'sima') {
        await auditAndFixCategories(guild, 'sorsolas');
        await auditAndFixCategories(guild, 'partner');
        return;
    }
    const parents = categoryType === 'sorsolas' ? CONFIG.SORSOLAS_PARENTS : CONFIG.PARTNER_PARENTS;
    const suffix = categoryType === 'sorsolas' ? 'nyeremeny' : 'partner';

    let channels = [];
    for (const pId of parents) {
        const catChannels = guild.channels.cache.filter(c => c.parentId === pId).sort((a, b) => a.position - b.position);
        catChannels.forEach(c => channels.push(c));
    }
    guild.channels.cache.filter(c => !parents.includes(c.parentId) && c.name.includes(`-${suffix}-`)).forEach(c => channels.push(c));

    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const num = i + 1;
        const catIdx = Math.floor(i / 50);

        let targetParentId = parents[catIdx];
        if (!targetParentId) {
            const baseCat = guild.channels.cache.get(parents[0]);
            const newCat = await guild.channels.create({
                name: `🎁 Nyereményjáték (${parents.length + 1})`,
                type: ChannelType.GuildCategory,
                permissionOverwrites: baseCat ? baseCat.permissionOverwrites.cache.map(p => ({ id: p.id, allow: p.allow, deny: p.deny })) : []
            });
            parents.push(newCat.id);
            targetParentId = newCat.id;
        }

        let cleanUser = ch.name.replace(/^ticket-/, '').replace(new RegExp(`-${suffix}-\\d+$`), '').split('-')[0] || 'user';
        const expectedName = `${cleanUser}-${suffix}-${num}`;

        if (ch.parentId !== targetParentId) await ch.setParent(targetParentId, { lockPermissions: false }).catch(() => {});
        if (ch.name !== expectedName) await ch.setName(expectedName).catch(() => {});
    }
}

async function moveTicketCategory(channel, guild, type) {
    const userOverwrites = channel.permissionOverwrites.cache.filter(o => o.id !== guild.id && o.id !== client.user.id);
    if (type === 'sima') {
        let cleanUser = channel.name.replace(/^ticket-/, '').replace(/-(nyeremeny|partner)-\d+$/, '').split('-')[0] || 'user';
        await channel.setParent(CONFIG.DEFAULT_PARENT, { lockPermissions: false });
        await channel.setName(`ticket-${cleanUser}`);
        for (const [id] of userOverwrites) await channel.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
        setTimeout(() => auditAndFixCategories(guild, 'sima'), 1000);
        return { categoryName: 'Alapértelmezett Ticket' };
    }

    const parents = type === 'sorsolas' ? CONFIG.SORSOLAS_PARENTS : CONFIG.PARTNER_PARENTS;
    let targetCatId = parents[0];
    for (const pId of parents) {
        const cat = guild.channels.cache.get(pId);
        if (cat && guild.channels.cache.filter(c => c.parentId === cat.id).size < 50) { targetCatId = cat.id; break; }
    }

    await channel.setParent(targetCatId, { lockPermissions: false });
    for (const [id] of userOverwrites) await channel.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
    setTimeout(() => auditAndFixCategories(guild, type), 1000);
    return { categoryName: type === 'sorsolas' ? 'Nyereményjáték' : 'Partner' };
}

// ==========================================
// 5. MINIGAME LOGIC (MINES 5x5 & BLACKJACK)
// ==========================================
function getMinesMultiplier(totalTiles, bombs, revealed) {
    let mult = 0.96; 
    for (let i = 0; i < revealed; i++) {
        mult *= (totalTiles - i) / (totalTiles - bombs - i);
    }
    return Math.max(1.01, mult);
}

function buildMinesComponents(game, gameOver = false) {
    const rows = [];
    for (let r = 0; r < 5; r++) {
        const row = new ActionRowBuilder();
        for (let c = 0; c < 5; c++) {
            const idx = r * 5 + c;
            const btn = new ButtonBuilder().setCustomId(`mine_tile_${idx}`);
            if (gameOver) {
                btn.setDisabled(true);
                if (game.grid[idx] === '💣') btn.setLabel('💣').setStyle(ButtonStyle.Danger);
                else if (game.revealed.includes(idx)) btn.setLabel('💎').setStyle(ButtonStyle.Success);
                else btn.setLabel('💎').setStyle(ButtonStyle.Secondary);
            } else {
                if (game.revealed.includes(idx)) {
                    btn.setLabel('💎').setStyle(ButtonStyle.Success).setDisabled(true);
                } else {
                    btn.setLabel('❓').setStyle(ButtonStyle.Secondary);
                }
            }
            row.addComponents(btn);
        }
        rows.push(row);
    }
    return rows;
}

function createMinesEmbed(bet, bombs, revealedCount, currentMult, currentWin, title = '💣 AKNAKERESŐ (MINES)', color = '#00f2fe') {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .addFields(
            { name: '💵 TÉT', value: `\`\`\`${formatFt(bet)}\`\`\``, inline: true },
            { name: '📈 SZORZÓ', value: `\`\`\`x${currentMult.toFixed(2)}\`\`\``, inline: true },
            { name: '💰 VÁRHATÓ NYEREMÉNY', value: `\`\`\`${formatFt(currentWin)}\`\`\``, inline: true },
            { name: '📊 JÁTÉK ÁLLÁSA', value: `💎 Megtalált gyémántok: **${revealedCount} / ${25 - bombs}**\n💣 Bombák a pályán: **${bombs} db**\n\n*💡 Tipp: Reagálj a ✅ emojira a kifizetéshez!*`, inline: false }
        );
}

const CARD_SUITS = ['♠️', '♥️', '♦️', '♣️'];
const CARD_VALUES = [
    { name: '2', value: 2 }, { name: '3', value: 3 }, { name: '4', value: 4 }, 
    { name: '5', value: 5 }, { name: '6', value: 6 }, { name: '7', value: 7 }, 
    { name: '8', value: 8 }, { name: '9', value: 9 }, { name: '10', value: 10 }, 
    { name: 'J', value: 10 }, { name: 'Q', value: 10 }, { name: 'K', value: 10 }, 
    { name: 'A', value: 11 }
];

function getRandomCard() {
    const suit = CARD_SUITS[Math.floor(Math.random() * CARD_SUITS.length)];
    const cardObj = CARD_VALUES[Math.floor(Math.random() * CARD_VALUES.length)];
    return { display: `${cardObj.name}${suit}`, value: cardObj.value };
}

function calculateHand(cards) {
    let sum = cards.reduce((acc, c) => acc + c.value, 0);
    let aces = cards.filter(c => c.value === 11).length;
    while (sum > 21 && aces > 0) { sum -= 10; aces--; }
    return sum;
}

// ==========================================
// 6. GIVEAWAY & REMINDER SYSTEMS
// ==========================================
async function endGiveaway(gwData) {
    try {
        const checkDb = await Giveaway.findOne({ messageId: gwData.messageId });
        if (!checkDb) return;
        const guild = client.guilds.cache.get(gwData.guildId);
        const channel = guild?.channels.cache.get(gwData.channelId);
        const message = await channel?.messages.fetch(gwData.messageId).catch(() => null);
        if (!guild || !channel || !message) return;

        const reaction = message.reactions.cache.get('🎉');
        let validUsers = [];
        if (reaction) {
            let lastId;
            while (true) {
                const fetched = await reaction.users.fetch({ limit: 100, after: lastId });
                if (!fetched.size) break;
                validUsers.push(...fetched.filter(u => !u.bot).map(u => u.id));
                lastId = fetched.last().id;
                if (fetched.size < 100) break;
            }
        }

        if (!validUsers.length) {
            const endEmbed = EmbedBuilder.from(message.embeds[0]).setDescription('A nyereményjáték lezárult!').addFields({ name: 'Nyertes(ek)', value: 'Nincs résztvevő 😢' });
            await message.edit({ embeds: [endEmbed] });
            await channel.send('A nyereményjáték véget ért, de senki sem jelentkezett.');
        } else {
            const members = await guild.members.fetch({ user: validUsers }).catch(() => new Map());
            const participants = validUsers.map(uId => ({ id: uId, weight: members.get(uId)?.premiumSince ? 100 + gwData.boosterBonus : 100 }));
            const winners = drawWinners(participants, gwData.winnerCount);
            const mentions = winners.map(id => `<@${id}>`).join(' ');

            let embedVal = mentions.length > 1000 ? `🎉 **${winners.length} nyertes kisorsolva!**` : mentions;
            await message.edit({ embeds: [EmbedBuilder.from(message.embeds[0]).setDescription('A nyereményjáték lezárult!').addFields({ name: 'Nyertes(ek)', value: embedVal })] });

            const header = `🎉 **Gratulálok a nyerteseknek!** 🎉\n🎁 **Nyeremény:** ${gwData.prize}\n👑 **Nyertes(ek):**\n`;
            if ((header + mentions).length <= 2000) await channel.send(`${header}${mentions}`);
            else {
                await channel.send(header);
                let msg = "";
                for (const wId of winners) {
                    if ((msg + `<@${wId}> `).length > 1900) { await channel.send(msg); msg = ""; }
                    msg += `<@${wId}> `;
                }
                if (msg) await channel.send(msg);
            }
        }
        checkDb.ended = true;
        await checkDb.save();
    } catch (e) { console.error(e); }
}

let lastTriggeredMinute = '';
setInterval(async () => {
    const timeStr = new Date().toLocaleTimeString('hu-HU', { timeZone: 'Europe/Budapest', hour: '2-digit', minute: '2-digit', hour12: false });
    if (['15:58', '15:59', '16:00', '19:58', '19:59', '20:00'].includes(timeStr) && lastTriggeredMinute !== timeStr) {
        lastTriggeredMinute = timeStr;
        const channel = client.channels.cache.get(CONFIG.REMINDER_CHANNEL);
        if (channel) {
            const alertEmoji = channel.guild?.emojis.cache.find(e => e.name.toLowerCase() === 'alert') || '🚨';
            const eventTime = ['15:58', '15:59', '16:00'].includes(timeStr) ? '16:00' : '20:00';
            const count = Math.floor(Math.random() * 4) + 5;
            for (let i = 0; i < count; i++) {
                await channel.send({ content: `${alertEmoji} 🚨 **RIASZTÁS! MEGY A VÁNDORKERESKEDŐ! (${eventTime})** 🚨 ${alertEmoji}\n<@&${CONFIG.REMINDER_ROLE}>` }).catch(() => {});
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }
}, 10000);

// ==========================================
// 7. SLASH COMMANDS REGISTRATION
// ==========================================
const ADMIN_PERM = PermissionFlagsBits.ManageGuild.toString();

const commands = [
    new SlashCommandBuilder().setName('giveaway').setDescription('Nyereményjáték parancsok').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false)
        .addSubcommand(s => s.setName('start').setDescription('Indítás').addStringOption(o => o.setName('duration').setDescription('Időtartam').setRequired(true)).addStringOption(o => o.setName('prize').setDescription('Nyeremény').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Nyertesek').setRequired(true).setMinValue(1)).addIntegerOption(o => o.setName('booster_bonus').setDescription('Booster bónusz %')))
        .addSubcommand(s => s.setName('reroll').setDescription('Újrasorsolás').addStringOption(o => o.setName('message_id').setDescription('Üzenet ID').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Új nyertesek')))
        .addSubcommand(s => s.setName('end').setDescription('Leállítás').addStringOption(o => o.setName('message_id').setDescription('Üzenet ID').setRequired(true))),
    new SlashCommandBuilder().setName('ticket').setDescription('Ticket parancsok').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false)
        .addSubcommand(s => s.setName('setup').setDescription('Panel elküldése'))
        .addSubcommand(s => s.setName('sorsolas').setDescription('Nyereményjáték kategóriába'))
        .addSubcommand(s => s.setName('partner').setDescription('Partner kategóriába'))
        .addSubcommand(s => s.setName('sima').setDescription('Vissza az alapértelmezett kategóriába')),
    new SlashCommandBuilder().setName('fakeban').setDescription('Troll kamu kitiltás').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Felhasználó').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Indok')),
    new SlashCommandBuilder().setName('nitro').setDescription('Ingyen Discord Nitro ajándék (kamu)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false),
    new SlashCommandBuilder().setName('mock').setDescription('Spongyabob gúnyolódó szöveg').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addStringOption(o => o.setName('text').setDescription('A szöveg').setRequired(true)),
    new SlashCommandBuilder().setName('roulette').setDescription('Orosz rulett játék (1/6 esély 1 perces némításra)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false),
    new SlashCommandBuilder().setName('roast').setDescription('Vicces beszólogatás').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Kinek szóljon?').setRequired(true)),
    new SlashCommandBuilder().setName('rate').setDescription('Értékelj bármit').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addStringOption(o => o.setName('thing').setDescription('Mit értékeljen?').setRequired(true)),

    new SlashCommandBuilder().setName('invites').setDescription('Meghívók lekérése').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('treasure').setDescription('Ingyen Forint kikérése (Boostereknek 7 perc, másnak 10 perc)'),
    new SlashCommandBuilder().setName('daily').setDescription('Napi ingyen jutalom (100.000 Ft, éjfélimit)'),
    new SlashCommandBuilder().setName('work').setDescription('Munkavégzés pénzért (3k - 10k Ft, 1 perc cooldown)'),
    new SlashCommandBuilder().setName('bal').setDescription('Egyenleg lekérése').addUserOption(o => o.setName('user').setDescription('Kinek az egyenlege?')),
    new SlashCommandBuilder().setName('stat').setDescription('Kaszinó statisztika lekérése').addUserOption(o => o.setName('user').setDescription('Kinek a statisztikája?')),
    new SlashCommandBuilder().setName('utalas').setDescription('Pénz küldése másnak').addUserOption(o => o.setName('user').setDescription('Kinek?').setRequired(true)).addIntegerOption(o => o.setName('amount').setDescription('Összeg (Ft)').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('top').setDescription('A szerver leggazdagabb tagjai'),
    new SlashCommandBuilder().setName('mines').setDescription('Aknakereső kaszinó minijáték').addIntegerOption(o => o.setName('bet').setDescription('Tét összege (Ft)').setRequired(true).setMinValue(100)).addIntegerOption(o => o.setName('bombs').setDescription('Bombák száma (1-24)').setRequired(true).setMinValue(1).setMaxValue(24)),
    new SlashCommandBuilder().setName('blackjack').setDescription('Klasszikus 21-es blackjack kártyajáték').addIntegerOption(o => o.setName('bet').setDescription('Tét összege (Ft)').setRequired(true).setMinValue(100)),
    new SlashCommandBuilder().setName('iq').setDescription('IQ teszt mérés').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('meret').setDescription('Faszméret mérés').addUserOption(o => o.setName('user').setDescription('Kinek a mérete?'))
].map(c => c.toJSON());

// ==========================================
// 8. BOT READY & EVENT LISTENERS
// ==========================================
client.once('ready', async () => {
    console.log(`Sikeresen elindult: ${client.user.tag}`);
    try {
        await new REST({ version: '10' }).setToken(process.env.TOKEN).put(Routes.applicationGuildCommands(client.user.id, CONFIG.GUILD_ID), { body: commands });
        console.log('✅ Szerver-specifikus Slash parancsok frissítve!');
    } catch (err) { console.error('❌ Hiba a parancsok regisztrációjánál:', err); }

    updateStatus(client.guilds.cache.first());

    const active = await Giveaway.find({ ended: false });
    const now = Date.now();
    for (const gw of active) {
        const rem = gw.endTime - now;
        rem <= 0 ? endGiveaway(gw) : setTimeout(() => endGiveaway(gw), rem);
    }
});

client.on('guildMemberAdd', async (m) => {
    updateStatus(m.guild);
    try {
        const invs = await m.guild.invites.fetch();
        const inv = invs.find(i => i.uses > 0);
        if (inv) {
            let data = await Invite.findOne({ guildId: m.guild.id, userId: inv.inviter.id }) || new Invite({ guildId: m.guild.id, userId: inv.inviter.id, invites: 0 });
            data.invites += 1;
            await data.save();
        }
    } catch (e) {}
});
client.on('guildMemberRemove', (m) => updateStatus(m.guild));

client.on('messageCreate', async (m) => {
    if (m.author.bot || !m.guild) return;
    const cmd = m.content.toLowerCase().trim();

    if (Math.random() < 0.015) m.react(Math.random() < 0.5 ? '🤡' : '🤓').catch(() => {});
    if (cmd === 'mikor') return m.reply('Majd ha piros hó esik! 🤡').catch(() => {});
    if (cmd === 'miért' || cmd === 'miert') return m.reply('Mert csak! 🤫').catch(() => {});

    if (['.sorsolas', '.partner', '.sima'].includes(cmd)) {
        await m.delete().catch(() => {});
        if (!m.member?.roles?.cache?.has(CONFIG.STAFF_ROLE)) {
            const r = await m.channel.send('❌ Nincs jogosultságod!');
            return setTimeout(() => r.delete().catch(() => {}), 3000);
        }
        try {
            const res = await moveTicketCategory(m.channel, m.guild, cmd.replace('.', ''));
            const r = await m.channel.send(`✅ Ticket áthelyezve ide: **${res.categoryName}**!`);
            setTimeout(() => r.delete().catch(() => {}), 4000);
        } catch (err) {
            const r = await m.channel.send(`❌ Hiba: ${err.message || 'Ellenőrizd a bot jogait!'}`);
            setTimeout(() => r.delete().catch(() => {}), 5000);
        }
    }
});

// ==========================================
// 9. INTERACTIONS & REACTIONS (MINES & BLACKJACK)
// ==========================================
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || !reaction.message.guild) return;
    if (reaction.emoji.name !== '✅') return;

    const game = Array.from(activeMines.values()).find(g => g.msgId === reaction.message.id);
    if (!game) return;

    if (user.id !== game.userId) {
        await reaction.users.remove(user.id).catch(() => {});
        return;
    }

    if (game.revealed.length === 0) {
        await reaction.users.remove(user.id).catch(() => {});
        return;
    }

    activeMines.delete(game.msgId);
    const currentMult = getMinesMultiplier(25, game.bombs, game.revealed.length);
    const winAmount = Math.floor(game.bet * currentMult);
    const profit = winAmount - game.bet;

    const uDb = await getUserDb(reaction.message.guild.id, user.id);
    uDb.balance += winAmount;
    
    // Stat frissítés (Mines győzelem)
    if (!uDb.stats) uDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };
    uDb.stats.mines.played += 1;
    uDb.stats.mines.won += 1;
    uDb.stats.mines.netProfit += profit;
    await uDb.save();

    const endEmbed = new EmbedBuilder()
        .setColor('#00ff00')
        .setTitle('💰 KIFIZETÉS SIKERES!')
        .addFields(
            { name: '🏆 MEGNYERT ÖSSZEG', value: `\`\`\`${formatFt(winAmount)}\`\`\``, inline: true },
            { name: '📈 VÉGSŐ SZORZÓ', value: `\`\`\`x${currentMult.toFixed(2)}\`\`\``, inline: true },
            { name: '💳 ÚJ EGYENLEGED', value: `\`\`\`${formatFt(uDb.balance)}\`\`\``, inline: false }
        )
        .setDescription('Sikeresen kiszálltál a játékból a ✅ pipával!');

    try {
        await reaction.message.edit({ embeds: [endEmbed], components: buildMinesComponents(game, true) });
        await reaction.message.reactions.removeAll().catch(() => {});
    } catch (e) {}
});

client.on('interactionCreate', async (i) => {
    if (!i.isCommand() && !i.isButton()) return;

    if (i.isChatInputCommand()) {
        const isStaff = i.member?.roles?.cache?.has(CONFIG.STAFF_ROLE);
        const isMember = i.member?.roles?.cache?.has(CONFIG.MEMBER_ROLE) || isStaff;
        const allowedForMembers = ['mines', 'blackjack', 'iq', 'meret', 'treasure', 'daily', 'work', 'bal', 'stat', 'utalas', 'top', 'invites'];

        if (!isMember) return i.reply({ content: '❌ Nincs meg a szükséges rangod a parancsok használatához!', ephemeral: true });
        if (!allowedForMembers.includes(i.commandName) && !isStaff) return i.reply({ content: '❌ Ez a parancs kizárólag a kijelölt rangosoknak érhető el!', ephemeral: true });

        const userDb = await getUserDb(i.guild.id, i.user.id);
        if (!userDb.stats) {
            userDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };
        }

        if (['meret', 'iq'].includes(i.commandName)) {
            const cooldownKey = `${i.user.id}_${i.commandName}`;
            const lastUsed = commandCooldowns.get(cooldownKey) || 0;
            const cd = 60 * 1000;
            if (Date.now() - lastUsed < cd) {
                const remainingSec = Math.ceil((cd - (Date.now() - lastUsed)) / 1000);
                return i.reply({ content: `⏳ Ezt a parancsot csak 1 percenként használhatod! Várj még **${remainingSec} másodpercet**.`, ephemeral: true });
            }
            commandCooldowns.set(cooldownKey, Date.now());
        }

        if (i.commandName === 'blackjack') {
            const bet = i.options.getInteger('bet');
            if (userDb.balance < bet) return i.reply({ content: '❌ Nincs elég egyenleged ehhez a téthez!', ephemeral: true });

            userDb.balance -= bet;
            await userDb.save();

            const playerCards = [getRandomCard(), getRandomCard()];
            const dealerCards = [getRandomCard(), getRandomCard()];
            const playerSum = calculateHand(playerCards);
            const dealerSum = calculateHand(dealerCards);

            const game = { userId: i.user.id, bet, playerCards, dealerCards, gameOver: false };

            if (playerSum === 21) {
                game.gameOver = true;
                const winAmount = Math.floor(bet * 2.5);
                const profit = winAmount - bet;
                userDb.balance += winAmount;
                
                userDb.stats.blackjack.played += 1;
                userDb.stats.blackjack.won += 1;
                userDb.stats.blackjack.netProfit += profit;
                await userDb.save();

                const embed = new EmbedBuilder()
                    .setColor('#ffd700')
                    .setTitle('♠️ KASZINÓ BLACKJACK ASZTAL ♣️')
                    .setDescription('✨ **BLACKJACK! Azonnali főnyeremény!** ✨')
                    .addFields(
                        { name: '🧑 Játékos lapjai', value: `\`\`\`css\n${playerCards.map(c => c.display).join(' ')} (Összeg: ${playerSum})\`\`\``, inline: false },
                        { name: '🤖 Osztó lapjai', value: `\`\`\`css\n${dealerCards.map(c => c.display).join(' ')} (Összeg: ${dealerSum})\`\`\``, inline: false },
                        { name: '💰 Nyeremény', value: `\`\`\`diff\n+${formatFt(winAmount)}\`\`\``, inline: true }
                    );
                return i.reply({ embeds: [embed] });
            }

            const embed = new EmbedBuilder()
                .setColor('#2f3136')
                .setTitle('♠️ KASZINÓ BLACKJACK ASZTAL ♣️')
                .addFields(
                    { name: '🧑 Játékos lapjai', value: `\`\`\`css\n${playerCards.map(c => c.display).join(' ')} (Összeg: ${playerSum})\`\`\``, inline: false },
                    { name: '🤖 Osztó lapjai', value: `\`\`\`css\n${dealerCards[0].display} 🎴 (Rejtett)\`\`\``, inline: false },
                    { name: '💵 Tét', value: `\`\`\`${formatFt(bet)}\`\`\``, inline: true }
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('bj_hit').setLabel('➕ Lapot kérlek (Hit)').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('bj_stand').setLabel('🛑 Megállok (Stand)').setStyle(ButtonStyle.Success)
            );

            const msg = await i.reply({ embeds: [embed], components: [row], fetchReply: true });
            activeBlackjack.set(msg.id, game);
            return;
        }

        if (i.commandName === 'daily') {
            const now = new Date();
            const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

            if (userDb.lastDaily >= todayMidnight) {
                const tomorrowMidnight = todayMidnight + 24 * 60 * 60 * 1000;
                const diffMs = tomorrowMidnight - now.getTime();
                const hours = Math.floor(diffMs / (1000 * 60 * 60));
                const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                return i.reply({ content: `⏳ Már felvetted a mai napi jutalmat! Várj még **${hours} órát és ${minutes} percet**.` });
            }

            const dailyAmount = 100000;
            userDb.balance += dailyAmount;
            userDb.lastDaily = now.getTime();
            await userDb.save();
            return i.reply({ content: `🎁 Sikeresen felvedd a mai napi jutalmat: **${formatFt(dailyAmount)}** jóváírva az egyenlegeden! 🎉` });
        }

        if (i.commandName === 'work') {
            const now = Date.now();
            const cd = 60 * 1000;
            if (now - userDb.lastWork < cd) {
                const remainingSec = Math.ceil((cd - (now - userDb.lastWork)) / 1000);
                return i.reply({ content: `⏳ Pihenj még **${remainingSec} másodpercet** a következő munka előtt.`, ephemeral: true });
            }

            const workAmount = Math.floor(Math.random() * 7001) + 3000;
            userDb.balance += workAmount;
            userDb.lastWork = now;
            await userDb.save();

            const jobs = [
                `Sikeresen kiszállítottál egy csomagot, és kaptál **${formatFt(workAmount)}**-ot! 📦`,
                `Ledolgoztál egy műszakot a vándorkereskedőnél, a fizetésed: **${formatFt(workAmount)}**! 🛒`,
                `Felsöpörtél a kaszinóban, a jutalmad: **${formatFt(workAmount)}**! 🧹`,
                `Besegítettél a szerver karbantartásába, kaptál **${formatFt(workAmount)}**-ot! 🛠️`
            ];
            return i.reply({ content: jobs[Math.floor(Math.random() * jobs.length)] });
        }

        if (i.commandName === 'treasure') {
            const now = Date.now();
            const isBooster = i.member?.roles?.cache?.has(CONFIG.BOOSTER_ROLE);
            const cd = (isBooster ? 7 : 10) * 60 * 1000;

            if (now - userDb.lastTreasure < cd) {
                const remaining = Math.ceil((cd - (now - userDb.lastTreasure)) / 1000 / 60);
                return i.reply({ content: `⏳ Még várnod kell **${remaining} percet** a következő kincsig!${isBooster ? ' (💎 Booster kedvezmény: 7 perc cooldown)' : ''}`, ephemeral: true });
            }

            const isSuperChest = Math.random() < 0.05;
            const amount = isSuperChest ? 250000 : Math.floor(Math.random() * 28001) + 20000;

            userDb.balance += amount;
            userDb.lastTreasure = now;
            await userDb.save();

            if (isSuperChest) {
                return i.reply({ content: `✨ **SZUPER LÁDA JACKPOT!** ✨ Ritka kincset találtál: **${formatFt(amount)}** íródott jóvá az egyenlegeden! 🎉` });
            } else {
                return i.reply({ content: `🪙 Kinyitottad a ládát és találtál benne: **${formatFt(amount)}**-ot!` });
            }
        }

        if (i.commandName === 'bal') {
            const target = i.options.getUser('user') || i.user;
            const targetDb = await getUserDb(i.guild.id, target.id);
            return i.reply({ content: `💳 **${target.username}** egyenlege: **${formatFt(targetDb.balance)}**` });
        }

        if (i.commandName === 'stat') {
            const target = i.options.getUser('user') || i.user;
            const targetDb = await getUserDb(i.guild.id, target.id);
            const s = targetDb.stats || { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };

            const totalPlayed = s.blackjack.played + s.mines.played;
            const totalWon = s.blackjack.won + s.mines.won;
            const overallWinRate = totalPlayed > 0 ? ((totalWon / totalPlayed) * 100).toFixed(1) : 0;
            const overallProfit = s.blackjack.netProfit + s.mines.netProfit;

            const bjWinRate = s.blackjack.played > 0 ? ((s.blackjack.won / s.blackjack.played) * 100).toFixed(1) : 0;
            const minesWinRate = s.mines.played > 0 ? ((s.mines.won / s.mines.played) * 100).toFixed(1) : 0;

            const formatProfit = (val) => val >= 0 ? `+${formatFt(val)}` : `-${formatFt(Math.abs(val))}`;

            const embed = new EmbedBuilder()
                .setColor('#00f2fe')
                .setTitle(`📊 Kaszinó Statisztika: ${target.username}`)
                .addFields(
                    { name: '🌐 Összesített (Overall)', value: `• **Nyerési arány:** ${overallWinRate}%\n• **Lejátszott körök:** ${totalPlayed} db\n• **Profit / Mínusz:** **${formatProfit(overallProfit)}**`, inline: false },
                    { name: '♠️ Blackjack Statisztika', value: `• **Nyerési arány:** ${bjWinRate}% (${s.blackjack.won}/${s.blackjack.played})\n• **Profit / Mínusz:** **${formatProfit(s.blackjack.netProfit)}**`, inline: true },
                    { name: '💣 Mines Statisztika', value: `• **Nyerési arány:** ${minesWinRate}% (${s.mines.won}/${s.mines.played})\n• **Profit / Mínusz:** **${formatProfit(s.mines.netProfit)}**`, inline: true }
                );

            return i.reply({ embeds: [embed] });
        }

        if (i.commandName === 'utalas') {
            const target = i.options.getUser('user');
            const amount = i.options.getInteger('amount');
            if (target.id === i.user.id) return i.reply({ content: '❌ Magadnak nem utalhatsz!', ephemeral: true });
            if (userDb.balance < amount) return i.reply({ content: '❌ Nincs ennyi pénzed!', ephemeral: true });

            const targetDb = await getUserDb(i.guild.id, target.id);
            userDb.balance -= amount;
            targetDb.balance += amount;
            await userDb.save();
            await targetDb.save();
            return i.reply({ content: `💸 Sikeresen átutaltál **${formatFt(amount)}**-ot <@${target.id}> felhasználónak!` });
        }

        if (i.commandName === 'top') {
            const topUsers = await User.find({ guildId: i.guild.id }).sort({ balance: -1 }).limit(10);
            let desc = "";
            topUsers.forEach((u, index) => desc += `**${index + 1}.** <@${u.userId}> — **${formatFt(u.balance)}**\n`);
            const embed = new EmbedBuilder().setColor('#ffd700').setTitle('🏆 A Szerver Leggazdagabb Tagjai').setDescription(desc || 'Még senkinek sincs pénze.');
            return i.reply({ embeds: [embed] });
        }

        if (i.commandName === 'mines') {
            await i.deferReply();

            const bet = i.options.getInteger('bet');
            const bombs = i.options.getInteger('bombs');
            if (userDb.balance < bet) return i.editReply({ content: '❌ Nincs elég egyenleged a játék elindításához!' });

            userDb.balance -= bet;
            await userDb.save();

            const grid = Array(25).fill('💎');
            let placed = 0;
            while (placed < bombs) {
                const rand = Math.floor(Math.random() * 25);
                if (grid[rand] !== '💣') { grid[rand] = '💣'; placed++; }
            }

            const game = { userId: i.user.id, bet, bombs, grid, revealed: [] };
            const embed = createMinesEmbed(bet, bombs, 0, 1.00, bet);
            const rows = buildMinesComponents(game);

            const msg = await i.editReply({ embeds: [embed], components: rows });
            game.msgId = msg.id;
            await msg.react('✅');

            activeMines.set(msg.id, game);
            return;
        }

        if (['iq', 'meret'].includes(i.commandName)) {
            await i.deferReply({ ephemeral: true });
            if (i.commandName === 'iq') {
                const target = i.options.getUser('user') || i.user;
                const iqVal = Math.floor(Math.random() * 251) - 50;
                let comment = iqVal < 0 ? "Néha elfelejt levegőt venni. 🧠❌" : (iqVal < 50 ? "A gombalevest is villával eszi. 🥣" : (iqVal < 100 ? "Nem a legélesebb kés a fiókban. 🗡️" : "Smart koponya! 💡"));
                await i.channel.send({ content: `🧠 **<@${target.id}>** IQ teszt eredménye: **${iqVal} IQ**\n*Értékelés:* ${comment}` });
                await i.deleteReply().catch(() => {});
            } else if (i.commandName === 'meret') {
                const target = i.options.getUser('user') || i.user;
                const sizeNum = Math.floor(Math.random() * 30) + 1;
                await i.channel.send({ content: `🍆 **<@${target.id}>** fasz mérete: **8${'='.repeat(sizeNum)}D** (${sizeNum} cm)` });
                await i.deleteReply().catch(() => {});
            }
            return;
        }

        if (['fakeban', 'nitro', 'mock', 'roulette', 'roast', 'rate'].includes(i.commandName)) {
            await i.deferReply({ ephemeral: true });
            if (i.commandName === 'fakeban') {
                const user = i.options.getUser('user');
                const reason = i.options.getString('reason') || 'Nincs megadva';
                const banEmbed = new EmbedBuilder().setColor('#ff0000').setTitle('🔨 Tag Kitiltva!').setDescription(`**Felhasználó:** <@${user.id}>\n**Indok:** ${reason}\n**Moderátor:** Adminisztráció`);
                const msg = await i.channel.send({ embeds: [banEmbed] });
                await i.deleteReply().catch(() => {});
                setTimeout(() => msg.edit({ embeds: [new EmbedBuilder().setColor('#ffaa00').setTitle('🤡 CSAK VICCELTEM!').setDescription(`**<@${user.id}>** nem lett kitiltva, maradhatsz! 🎉`)] }).catch(() => {}), 3000);
            } else if (i.commandName === 'nitro') {
                const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎁 Discord Nitro Gift!').setDescription('Nyertél 1 hónap Discord Nitro-t! Kattints az alábbi gombra az átvételhez!').setThumbnail('https://i.imgur.com/264293f.png');
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('claim_fake_nitro').setLabel('🎁 Claim Nitro').setStyle(ButtonStyle.Success));
                await i.channel.send({ embeds: [embed], components: [btn] });
                await i.deleteReply().catch(() => {});
            } else if (i.commandName === 'mock') {
                const mocked = i.options.getString('text').split('').map((c, idx) => idx % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
                await i.channel.send({ content: `${mocked} 🤡` });
                await i.deleteReply().catch(() => {});
            } else if (i.commandName === 'roulette') {
                if (Math.floor(Math.random() * 6) === 0) {
                    await i.member.timeout(60 * 1000, 'Orosz rulett vesztes').catch(() => {});
                    await i.channel.send({ content: `💥 **BANG!** <@${i.user.id}> meghúzta a ravaszt, a fegyver eldördült! (1 perc némítás) 🪦` });
                } else {
                    await i.channel.send({ content: `*KIKK...* <@${i.user.id}> meghúzta a ravaszt, a fegyver nem sült el. Túlélte! 🎯` });
                }
                await i.deleteReply().catch(() => {});
            } else if (i.commandName === 'roast') {
                const target = i.options.getUser('user');
                const roasts = ["Mikor Isten az észt osztotta, te valószínűleg a sor végén álltál egy törött csészével. ☕", "Olyan vagy, mint a felhős idő: ha eltűnsz, mindenkinek szebb lesz a napja. ☀️", "Ha az ostobaság fájna, egész nap üvöltenél. 🔊"];
                await i.channel.send({ content: `🔥 **<@${target.id}>**: ${roasts[Math.floor(Math.random() * roasts.length)]}` });
                await i.deleteReply().catch(() => {});
            } else if (i.commandName === 'rate') {
                const rating = Math.floor(Math.random() * 10) + 1;
                await i.channel.send({ content: `⭐ Értékelés: **"${i.options.getString('thing')}"**\n📊 Eredmény: **${rating}/10**` });
                await i.deleteReply().catch(() => {});
            }
            return;
        }

        if (i.commandName === 'invites') {
            const user = i.options.getUser('user') || i.user;
            const data = await Invite.findOne({ guildId: i.guild.id, userId: user.id });
            return i.reply({ content: `📩 **${user.username}** eddig **${data ? data.invites : 0}** embert hívott meg!`, ephemeral: false });
        }

        if (i.commandName === 'ticket') {
            const sub = i.options.getSubcommand();
            if (sub === 'setup') {
                const embed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎫 Ticket Nyitása').setDescription('Kattints az alábbi gombra privát csatorna nyitásához!');
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('📩 Ticket Nyitása').setStyle(ButtonStyle.Primary));
                await i.channel.send({ embeds: [embed], components: [btn] });
                return i.reply({ content: '✅ Panel elkészült!', ephemeral: true });
            }
            if (['sorsolas', 'partner', 'sima'].includes(sub)) {
                try {
                    const res = await moveTicketCategory(i.channel, i.guild, sub);
                    return i.reply({ content: `✅ Ticket áthelyezve ide: **${res.categoryName}**!`, ephemeral: true });
                } catch (err) { return i.reply({ content: `❌ Hiba történt!`, ephemeral: true }); }
            }
        }

        if (i.commandName === 'giveaway') {
            const sub = i.options.getSubcommand();
            if (sub === 'start') {
                const durMs = ms(i.options.getString('duration'));
                if (!durMs) return i.reply({ content: '❌ Érvénytelen idő!', ephemeral: true });
                const prize = i.options.getString('prize');
                const winners = i.options.getInteger('winners');
                const bonus = i.options.getInteger('booster_bonus') || 0;
                const endTime = Math.floor((Date.now() + durMs) / 1000);

                const embed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎁 Nyereményjáték 🎁').setDescription('Reagálj a 🎉 emojival!').addFields({ name: 'Nyeremény', value: prize }, { name: 'Nyertesek', value: `${winners}`, inline: true }, { name: 'Indította', value: `<@${i.user.id}>`, inline: true }, { name: 'Lejárat', value: `<t:${endTime}:f>` });
                if (bonus > 0) embed.addFields({ name: '💎 Booster Bónusz', value: `+${bonus}% esély` });

                const msg = await i.reply({ embeds: [embed], fetchReply: true });
                await msg.react('🎉');

                const newGw = new Giveaway({ messageId: msg.id, channelId: i.channelId, guildId: i.guildId, endTime: Date.now() + durMs, prize, winnerCount: winners, boosterBonus: bonus });
                await newGw.save();
                setTimeout(() => endGiveaway(newGw), durMs);
            } else if (sub === 'reroll') {
                const msgId = i.options.getString('message_id');
                const count = i.options.getInteger('winners') || 1;
                await i.deferReply({ ephemeral: true });
                const gwData = await Giveaway.findOne({ messageId: msgId });
                if (!gwData) return i.editReply({ content: '❌ Nem található!' });

                const ch = i.guild.channels.cache.get(gwData.channelId);
                const msg = await ch?.messages.fetch(gwData.messageId).catch(() => null);
                const reaction = msg?.reactions.cache.get('🎉');
                let validUsers = [];
                if (reaction) {
                    let lastId;
                    while (true) {
                        const fetched = await reaction.users.fetch({ limit: 100, after: lastId });
                        if (!fetched.size) break;
                        validUsers.push(...fetched.filter(u => !u.bot).map(u => u.id));
                        lastId = fetched.last().id;
                        if (fetched.size < 100) break;
                    }
                }
                if (!validUsers.length) return i.editReply({ content: '❌ Nincs érvényes jelentkező!' });

                const members = await i.guild.members.fetch({ user: validUsers }).catch(() => new Map());
                const participants = validUsers.map(uId => ({ id: uId, weight: members.get(uId)?.premiumSince ? 100 + gwData.boosterBonus : 100 }));
                const winners = drawWinners(participants, count);
                const mentions = winners.map(id => `<@${id}>`).join(' ');

                await ch.send(`🎲 **Újrasorsolás (${winners.length} új nyertes)!** Nyeremény: **${gwData.prize}**!\n\n${mentions}`);
                return i.editReply({ content: `✅ Kisorsolva ${winners.length} új nyertes!` });
            } else if (sub === 'end') {
                const msgId = i.options.getString('message_id');
                await i.deferReply({ ephemeral: true });
                const gwData = await Giveaway.findOne({ messageId: msgId });
                if (!gwData) return i.editReply({ content: '❌ Nem található!' });
                gwData.ended = false;
                await endGiveaway(gwData);
                await i.editReply({ content: '✅ Lezárva és kisorsolva!' });
            }
        }
    }

    if (i.isButton()) {
        if (i.customId === 'bj_hit' || i.customId === 'bj_stand') {
            const game = activeBlackjack.get(i.message.id);
            if (!game) return i.reply({ content: '❌ Ez a játék már véget ért vagy lejárt!', ephemeral: true });
            if (i.user.id !== game.userId) return i.reply({ content: '❌ Ez nem a te kártyapartid! 🤡', ephemeral: true });
            if (game.gameOver) return i.reply({ content: '❌ Ez a kör már lezárult!', ephemeral: true });

            const uDb = await getUserDb(i.guild.id, i.user.id);
            if (!uDb.stats) uDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };

            if (i.customId === 'bj_hit') {
                game.playerCards.push(getRandomCard());
                const playerSum = calculateHand(game.playerCards);

                if (playerSum > 21) {
                    game.gameOver = true;
                    activeBlackjack.delete(i.message.id);
                    await addLossToVault(i.guild.id, game.bet);

                    uDb.stats.blackjack.played += 1;
                    uDb.stats.blackjack.netProfit -= game.bet;
                    await uDb.save();

                    const loseEmbed = new EmbedBuilder()
                        .setColor('#ff0000')
                        .setTitle('💥 TÚLHÚZTAD! (BUST)')
                        .addFields(
                            { name: '🧑 Játékos lapjai', value: `\`\`\`css\n${game.playerCards.map(c => c.display).join(' ')} (Összeg: ${playerSum})\`\`\``, inline: false },
                            { name: '🤖 Osztó lapjai', value: `\`\`\`css\n${game.dealerCards.map(c => c.display).join(' ')} (Összeg: ${calculateHand(game.dealerCards)})\`\`\``, inline: false },
                            { name: '💸 Elveszített tét', value: `\`\`\`diff\n-${formatFt(game.bet)}\`\`\``, inline: true }
                        );
                    return i.update({ embeds: [loseEmbed], components: [] });
                }

                const embed = new EmbedBuilder()
                    .setColor('#2f3136')
                    .setTitle('♠️ KASZINÓ BLACKJACK ASZTAL ♣️')
                    .addFields(
                        { name: '🧑 Játékos lapjai', value: `\`\`\`css\n${game.playerCards.map(c => c.display).join(' ')} (Összeg: ${playerSum})\`\`\``, inline: false },
                        { name: '🤖 Osztó lapjai', value: `\`\`\`css\n${game.dealerCards[0].display} 🎴 (Rejtett)\`\`\``, inline: false },
                        { name: '💵 Tét', value: `\`\`\`${formatFt(game.bet)}\`\`\``, inline: true }
                    );
                return i.update({ embeds: [embed] });
            }

            if (i.customId === 'bj_stand') {
                game.gameOver = true;
                activeBlackjack.delete(i.message.id);

                let playerSum = calculateHand(game.playerCards);
                let dealerSum = calculateHand(game.dealerCards);

                while (dealerSum < 17) {
                    game.dealerCards.push(getRandomCard());
                    dealerSum = calculateHand(game.dealerCards);
                }

                let resultText = '', embedColor = '#2f3136';
                uDb.stats.blackjack.played += 1;

                if (dealerSum > 21 || playerSum > dealerSum) {
                    embedColor = '#00ff00';
                    const wonAmount = game.bet * 2;
                    const profit = game.bet; // Visszakapja a tétet + nyer annyit
                    uDb.balance += wonAmount;
                    
                    uDb.stats.blackjack.won += 1;
                    uDb.stats.blackjack.netProfit += profit;
                    resultText = `🎉 **NYERTÉL!** Kaptál **${formatFt(wonAmount)}**-ot!`;
                } else if (playerSum === dealerSum) {
                    embedColor = '#ffd700';
                    uDb.balance += game.bet; // Döntetlen, visszakapja
                    resultText = `🤝 **DÖNTETLEN (Push)!** Visszakaptad a téted (**${formatFt(game.bet)}**).`;
                } else {
                    embedColor = '#ff0000';
                    uDb.stats.blackjack.netProfit -= game.bet;
                    resultText = `😢 **VESZTETTÉL!** Az osztó nyert.`;
                    await addLossToVault(i.guild.id, game.bet);
                }
                await uDb.save();

                const finalEmbed = new EmbedBuilder()
                    .setColor(embedColor)
                    .setTitle('♠️ BLACKJACK - VÉGEREDMÉNY ♣️')
                    .setDescription(resultText)
                    .addFields(
                        { name: '🧑 Játékos lapjai', value: `\`\`\`css\n${game.playerCards.map(c => c.display).join(' ')} (Összeg: ${playerSum})\`\`\``, inline: false },
                        { name: '🤖 Osztó lapjai', value: `\`\`\`css\n${game.dealerCards.map(c => c.display).join(' ')} (Összeg: ${dealerSum})\`\`\``, inline: false },
                        { name: '💳 Új egyenleged', value: `\`\`\`${formatFt(uDb.balance)}\`\`\``, inline: true }
                    );
                return i.update({ embeds: [finalEmbed], components: [] });
            }
        }

        if (i.customId.startsWith('mine_tile_')) {
            const game = activeMines.get(i.message.id);
            if (!game) return i.reply({ content: '❌ Ez a játék már véget ért!', ephemeral: true });
            if (i.user.id !== game.userId) return i.reply({ content: '❌ Ez nem a te játékod! 🤡', ephemeral: true });

            const idx = parseInt(i.customId.split('_')[2]);
            if (game.revealed.includes(idx)) return i.deferUpdate();

            const uDb = await getUserDb(i.guild.id, i.user.id);
            if (!uDb.stats) uDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };

            if (game.grid[idx] === '💣') {
                activeMines.delete(i.message.id);
                await addLossToVault(i.guild.id, game.bet);

                uDb.stats.mines.played += 1;
                uDb.stats.mines.netProfit -= game.bet;
                await uDb.save();

                const loseEmbed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setTitle('💥 BUMM! AKNÁRA LÉPTÉL!')
                    .addFields({ name: '💸 ELVESZÍTETT TÉT', value: `\`\`\`${formatFt(game.bet)}\`\`\``, inline: true })
                    .setDescription('Sajnos bombát találtál, a teljes téted elveszett!');
                
                try {
                    await i.message.reactions.removeAll().catch(() => {});
                } catch(e) {}

                return i.update({ embeds: [loseEmbed], components: buildMinesComponents(game, true) });
            }

            game.revealed.push(idx);
            const currentMult = getMinesMultiplier(25, game.bombs, game.revealed.length);
            const currentWin = Math.floor(game.bet * currentMult);
            const updateEmbed = createMinesEmbed(game.bet, game.bombs, game.revealed.length, currentMult, currentWin, '💎 GYÉMÁNT TALÁLAT!');
            return i.update({ embeds: [updateEmbed], components: buildMinesComponents(game, false) });
        }

        if (i.customId === 'claim_fake_nitro') return i.reply({ content: `🎉 **<@${i.user.id}>** bedőlt a kamu Nitrónak és át lett verve! 🤡`, ephemeral: false });

        if (i.customId === 'open_ticket') {
            const name = `ticket-${i.user.username}`;
            if (i.guild.channels.cache.find(c => c.name === name.toLowerCase())) return i.reply({ content: `❌ Már van nyitott ticketed!`, ephemeral: true });

            const ch = await i.guild.channels.create({
                name, type: ChannelType.GuildText, parent: CONFIG.DEFAULT_PARENT,
                permissionOverwrites: [
                    { id: i.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: i.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
                ]
            });
            const embed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎫 Új Ticket').setDescription(`Üdv, <@${i.user.id}>!\nKérjük írd le miben segíthetünk.`);
            const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Lezárás').setStyle(ButtonStyle.Danger));
            await ch.send({ content: `<@${i.user.id}>`, embeds: [embed], components: [btn] });
            return i.reply({ content: `✅ Ticket nyitva: <#${ch.id}>`, ephemeral: true });
        }

        if (i.customId === 'close_ticket') {
            if (!i.member?.roles?.cache?.has(CONFIG.STAFF_ROLE)) return i.reply({ content: '❌ Nincs jogod!', ephemeral: true });
            await i.reply({ content: '🔒 Ticket lezárása...' });
            try {
                const msgs = await i.channel.messages.fetch({ limit: 100 });
                let text = `TICKET LEIRAT - ${i.channel.name}\n\n`;
                msgs.reverse().forEach(m => text += `[${new Date(m.createdTimestamp).toLocaleString('hu-HU')}] ${m.author.tag}: ${m.content}\n`);
                const file = new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: `${i.channel.name}-transcript.txt` });
                let logCh = i.guild.channels.cache.find(c => c.name === 'ticket-logok') || await i.guild.channels.create({ name: 'ticket-logok', type: ChannelType.GuildText });
                await logCh.send({ embeds: [new EmbedBuilder().setTitle('📝 Ticket Lezárva').setColor('#e74c3c').addFields({ name: 'Neve', value: i.channel.name }, { name: 'Lezárta', value: i.user.tag })], files: [file] });
                setTimeout(() => i.channel.delete().catch(() => {}), 3000);
            } catch (e) { i.editReply({ content: '❌ Hiba történt!' }); }
        }
    }
});

client.login(process.env.TOKEN);
