require('dotenv').config();
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
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
    MINER_CHANNEL: '1547004288188948581',
    REMINDER_ROLE: '1546794488372924476',
    BOOSTER_ROLE: '1449473778386997311',
    STAFF_ROLE: '1436671411178569832',
    MEMBER_ROLE: '1486847637134246139',
    FIXED_USER_ID: '1127950309247942797' // 👑 Fejlesztő / Tulajdonos ID
};

const BASE_BTC_PRICE = 35000000;
let isMaintenanceMode = false;

process.on('uncaughtException', (err) => {
    console.error('⚠️ ELKAPOTT FATÁLIS HIBA (a bot nem áll le):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ ELKAPOTT ASZINKRON HIBA (a bot nem áll le):', reason);
});

// ==========================================
// 2. DATABASE & MODELS
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Adatbázis csatlakoztatva!'))
    .catch(err => console.error('❌ DB hiba:', err));

const User = mongoose.model('User', new mongoose.Schema({ 
    guildId: String, 
    userId: String, 
    balance: { type: Number, default: 0 }, 
    loanDebt: { type: Number, default: 0 },
    btcBalance: { type: Number, default: 0 },
    roomType: { type: String, default: 'alagsor' },
    coolerType: { type: String, default: 'stock' },
    rigs: [{ gpuId: String, name: String, btcPerHour: Number }],
    isBroken: { type: Boolean, default: false },
    repairUntil: { type: Number, default: 0 },
    brokenAt: { type: Number, default: 0 },
    lastBtcClaim: { type: Number, default: Date.now },
    lastTreasure: { type: Number, default: 0 },
    lastDaily: { type: Number, default: 0 },
    lastWeekly: { type: Number, default: 0 },
    lastWork: { type: Number, default: 0 },
    totalMinedBtc: { type: Number, default: 0 },
    totalLoanRepaid: { type: Number, default: 0 },
    achievements: { type: [String], default: [] },
    quests: {
        lastReset: { type: Number, default: 0 },
        playBj: { type: Number, default: 0 },
        claimBtc: { type: Number, default: 0 },
        doWork: { type: Number, default: 0 },
        claimedBjReward: { type: Boolean, default: false },
        claimedBtcReward: { type: Boolean, default: false },
        claimedWorkReward: { type: Boolean, default: false }
    },
    stats: {
        blackjack: { played: { type: Number, default: 0 }, won: { type: Number, default: 0 }, netProfit: { type: Number, default: 0 } },
        mines: { played: { type: Number, default: 0 }, won: { type: Number, default: 0 }, netProfit: { type: Number, default: 0 } }
    }
}));

const GuildSetting = mongoose.model('GuildSetting', new mongoose.Schema({
    guildId: String,
    casinoLossVault: { type: Number, default: 0 },
    casinoWinVault: { type: Number, default: 0 },
    btcPriceFt: { type: Number, default: BASE_BTC_PRICE },
    btcHistory: { type: [Number], default: Array(10).fill(BASE_BTC_PRICE) }
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
const activeCoinflips = new Map();
const commandCooldowns = new Map();

// ==========================================
// 3. HARDVER ADATOK
// ==========================================
const ROOMS = {
    alagsor: { name: '📦 Alagsori Doboz', price: 0, maxGpus: 4, failChance: 0.12, multiplier: 1.0 },
    garazs: { name: '🏠 Garázs Rig', price: 5000000, maxGpus: 12, failChance: 0.08, multiplier: 1.10 },
    szerver: { name: '🏢 Hivatalos Szerverterem', price: 35000000, maxGpus: 25, failChance: 0.05, multiplier: 1.25 },
    adatkozpont: { name: '⚡ Ipari Adatközpont', price: 150000000, maxGpus: 50, failChance: 0.03, multiplier: 1.50 }
};

const COOLERS = {
    stock: { id: 'stock', name: '❄️ Gyári Léghűtés', price: 0, failReduce: 0 },
    dual_fan: { id: 'dual_fan', name: '🌀 Dupla Ventilátoros Hűtés', price: 150000, failReduce: 0.01 },
    water: { id: 'water', name: '🌊 Vízhűtéses AIO Rendszer', price: 1500000, failReduce: 0.02 },
    ac_unit: { id: 'ac_unit', name: '❄️ Ipari Klímarendszer', price: 10000000, failReduce: 0.03 },
    quantum_cooling: { id: 'quantum_cooling', name: '🧪 Kvantum Folyadékhűtés', price: 50000000, failReduce: 0.04 }
};

const GPUS = {
    gt1030: { id: 'gt1030', name: 'NVIDIA GT 1030', rarity: 'common', price: 50000, btcPerHour: 0.000036 },
    rx550: { id: 'rx550', name: 'AMD Radeon RX 550', rarity: 'common', price: 75000, btcPerHour: 0.000054 },
    gtx1060: { id: 'gtx1060', name: 'NVIDIA GTX 1060 6GB', rarity: 'rare', price: 300000, btcPerHour: 0.000252 },
    rx580: { id: 'rx580', name: 'AMD Radeon RX 580', rarity: 'rare', price: 450000, btcPerHour: 0.000387 },
    rtx3060ti: { id: 'rtx3060ti', name: 'NVIDIA RTX 3060 Ti', rarity: 'epic', price: 1500000, btcPerHour: 0.001530 },
    rtx3080: { id: 'rtx3080', name: 'NVIDIA RTX 3080', rarity: 'epic', price: 3500000, btcPerHour: 0.003780 },
    rtx4090: { id: 'rtx4090', name: 'NVIDIA RTX 4090', rarity: 'legendary', price: 10000000, btcPerHour: 0.012600 },
    rx7900xtx: { id: 'rx7900xtx', name: 'AMD Radeon RX 7900 XTX', rarity: 'legendary', price: 12500000, btcPerHour: 0.016200 },
    h100: { id: 'h100', name: 'NVIDIA H100 AI Accelerator', rarity: 'mythic', price: 45000000, btcPerHour: 0.067500 },
    quantum: { id: 'quantum', name: 'Quantum Miner Rig X-1', rarity: 'mythic', price: 100000000, btcPerHour: 0.162000 }
};

async function syncUserGpuStats() {
    try {
        const users = await User.find({ "rigs.0": { $exists: true } });
        let updatedCount = 0;
        for (const user of users) {
            let isModified = false;
            for (let i = 0; i < user.rigs.length; i++) {
                const rig = user.rigs[i];
                const latestGpu = GPUS[rig.gpuId];
                if (latestGpu && rig.btcPerHour !== latestGpu.btcPerHour) {
                    rig.btcPerHour = latestGpu.btcPerHour;
                    rig.name = latestGpu.name;
                    isModified = true;
                }
            }
            if (isModified) {
                await user.save();
                updatedCount++;
            }
        }
        if (updatedCount > 0) console.log(`🔄 ${updatedCount} felhasználó videokártyái frissítve!`);
    } catch (err) {
        console.error('❌ Hiba a kártyák szinkronizálásakor:', err);
    }
}

// ==========================================
// 4. HELPER LOGIC
// ==========================================
const formatFt = (amount) => new Intl.NumberFormat('hu-HU').format(amount) + ' Ft';
const formatBtc = (amount) => (amount || 0).toFixed(8) + ' BTC';
const formatBtcWithFt = (btcAmount, priceFt) => `${formatBtc(btcAmount)} (~${formatFt(Math.floor((btcAmount || 0) * priceFt))})`;

const getBudapestDate = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
const getBudapestMidnightMs = () => {
    const bpNow = getBudapestDate();
    return new Date(bpNow.getFullYear(), bpNow.getMonth(), bpNow.getDate()).getTime();
};

const getUserDb = async (guildId, userId) => {
    let user = await User.findOne({ guildId, userId });
    if (!user) {
        const initialBalance = (userId === CONFIG.FIXED_USER_ID) ? 10000000 : 0;
        user = new User({ guildId, userId, balance: initialBalance, loanDebt: 0, rigs: [] });
        await user.save();
    }
    return user;
};

async function getGuildSettings(guildId) {
    let settings = await GuildSetting.findOne({ guildId });
    if (!settings) {
        settings = new GuildSetting({ guildId, casinoLossVault: 0, casinoWinVault: 0, btcPriceFt: BASE_BTC_PRICE, btcHistory: Array(10).fill(BASE_BTC_PRICE) });
        await settings.save();
    }
    return settings;
}

async function checkAndGrantAchievements(userDb, channel) {
    if (!userDb.achievements) userDb.achievements = [];
    const newUnlocked = [];

    const achievementsList = [
        { id: 'mined_1btc', name: '⛏️ Bányász Mester', desc: 'Termelj ki legalább 1.0 BTC-t!', check: () => (userDb.totalMinedBtc || 0) >= 1.0 },
        { id: 'loan_repaid_50m', name: '🏦 Hitelmentes Gigász', desc: 'Fizess vissza összesen 50,000,000 Ft hitelt!', check: () => (userDb.totalLoanRepaid || 0) >= 50000000 },
        { id: 'mines_10_bombs', name: '💣 Aknamentesítő', desc: 'Nyerj egy legalább 10 bombás Mines kört!', check: () => false },
        { id: 'bj_wins_25', name: '♠️ Kaszinó Cápa', desc: 'Nyerj legalább 25 Blackjack meccset!', check: () => (userDb.stats?.blackjack?.won || 0) >= 25 }
    ];

    for (const ach of achievementsList) {
        if (!userDb.achievements.includes(ach.id) && ach.check()) {
            userDb.achievements.push(ach.id);
            newUnlocked.push(ach.name);
        }
    }

    if (newUnlocked.length > 0) {
        await userDb.save();
        if (channel) {
            channel.send(`🎉 <@${userDb.userId}> feloldotta a következő mérföldköve(ke)t: **${newUnlocked.join(', ')}**! 🏆`).catch(() => {});
        }
    }
}

async function addLossToVault(guildId, amount) {
    if (amount <= 0) return;
    try {
        const settings = await getGuildSettings(guildId);
        settings.casinoLossVault += amount;
        await settings.save();
    } catch (e) {}
}

async function addWinToVault(guildId, amount) {
    if (amount <= 0) return;
    try {
        const settings = await getGuildSettings(guildId);
        settings.casinoWinVault = (settings.casinoWinVault || 0) + amount;
        await settings.save();
    } catch (e) {}
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

const updateStatus = (g) => {
    if (!g) return;
    if (isMaintenanceMode) {
        client.user.setPresence({ activities: [{ name: `🛑 BOT LEÁLLÍTVA / KARBANTARTÁS`, type: 0 }], status: 'dnd' });
    } else {
        client.user.setPresence({ activities: [{ name: `👥 ${g.memberCount} tag | /coinflip`, type: 4 }], status: 'online' });
    }
};

// ==========================================
// 5. TICKET MANAGEMENT
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
// 6. MINIGAME LOGIC
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
// 7. TIMERS & BALANCED MARKET EVENTS
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

let lastTriggeredIntervalKey = '';
setInterval(async () => {
    const bpDate = getBudapestDate();
    const minute = bpDate.getMinutes();
    const intervalKey = `${bpDate.getHours()}:${minute < 30 ? '00' : '30'}`;

    if ((minute === 0 || minute === 30) && lastTriggeredIntervalKey !== intervalKey) {
        lastTriggeredIntervalKey = intervalKey;
        
        try {
            const settings = await GuildSetting.findOne({});
            if (settings) {
                if (!settings.btcHistory || settings.btcHistory.length === 0) {
                    settings.btcHistory = Array(10).fill(BASE_BTC_PRICE);
                }
                
                let eventText = '';
                let changePercent = 0;
                const currentRatio = settings.btcPriceFt / BASE_BTC_PRICE;

                if (currentRatio < 0.75) {
                    changePercent = (Math.random() * 0.08) + 0.03;
                    eventText = '\n\n📈 **PIACI REAKCIÓ:** A befektetők kihasználják az alacsony árat! (+BULLISH)';
                } else if (currentRatio > 1.50) {
                    changePercent = (Math.random() * -0.08) - 0.01;
                    eventText = '\n\n📉 **PIACI CORRECTION:** Profitrealizálás miatti eladási hullám.';
                } else {
                    const isBullish = Math.random() < 0.52;
                    changePercent = isBullish ? (Math.random() * 0.06 + 0.01) : (Math.random() * -0.05 - 0.01);
                }

                if (Math.random() < 0.30) {
                    const newsEvents = [
                        { text: '🟢 **NEWS FLASH:** Egy vezető ETF alap jóváhagyásra került! (+20%)', mult: 0.20 },
                        { text: '🟢 **NEWS FLASH:** A világ legnagyobb kereskedelmi hálózata elfogadja a BTC-t! (+15%)', mult: 0.15 },
                        { text: '🟢 **NEWS FLASH:** Elindult a globális bányászati halving esemény! (+12%)', mult: 0.12 },
                        { text: '🔴 **NEWS FLASH:** Rövid távú szerverleállás történt az ázsiai bányákközpontokban! (-12%)', mult: -0.12 },
                        { text: '🔴 **NEWS FLASH:** Makrogazdasági kamatváltozások óvatosságra intenek! (-10%)', mult: -0.10 }
                    ];
                    const chosen = newsEvents[Math.floor(Math.random() * newsEvents.length)];
                    eventText = `\n\n📢 **PIACI HÍREK:**\n${chosen.text}`;
                    changePercent = chosen.mult;
                }

                let newPrice = Math.floor(settings.btcPriceFt * (1 + changePercent));
                const minPrice = BASE_BTC_PRICE * 0.50;
                const maxPrice = BASE_BTC_PRICE * 2.20;

                if (newPrice < minPrice) newPrice = minPrice;
                if (newPrice > maxPrice) newPrice = maxPrice;

                settings.btcPriceFt = newPrice;
                settings.btcHistory.push(newPrice);
                if (settings.btcHistory.length > 10) settings.btcHistory.shift();
                await settings.save();

                const minerCh = client.channels.cache.get(CONFIG.MINER_CHANNEL);
                if (minerCh) {
                    const diffPercent = (((newPrice - BASE_BTC_PRICE) / BASE_BTC_PRICE) * 100).toFixed(1);
                    const diffTag = diffPercent >= 0 ? `+${diffPercent}%` : `${diffPercent}%`;

                    const btcEmbed = new EmbedBuilder()
                        .setColor(diffPercent >= 0 ? '#2ecc71' : '#e74c3c')
                        .setTitle('📊 30 PERCES BITCOIN ÁRFOLYAM JELENTÉS')
                        .setDescription(`🪙 **1 BTC = ${formatFt(newPrice)}** (Összváltozás: \`${diffTag}\`)${eventText}`);

                    minerCh.send({ embeds: [btcEmbed] }).catch(() => {});
                }
            }

            const users = await User.find({ "rigs.0": { $exists: true }, isBroken: false });
            for (const u of users) {
                const room = ROOMS[u.roomType || 'alagsor'];
                const cooler = COOLERS[u.coolerType || 'stock'];
                const finalFailChance = Math.max(0.005, room.failChance - cooler.failReduce);

                if (Math.random() < finalFailChance) {
                    const now = Date.now();
                    const hoursPassed = Math.max(0, (now - (u.lastBtcClaim || now)) / (1000 * 60 * 60));
                    
                    let rawBtc = u.rigs ? u.rigs.reduce((sum, r) => sum + (r.btcPerHour || 0), 0) : 0;
                    let btcPerHourTotal = rawBtc * room.multiplier;
                    const accruedBtc = hoursPassed * btcPerHourTotal;

                    u.isBroken = true;
                    u.brokenAt = now;
                    u.lastBtcClaim = now;

                    if (accruedBtc > 0) {
                        u.btcBalance = (u.btcBalance || 0) + accruedBtc;
                        u.totalMinedBtc = (u.totalMinedBtc || 0) + accruedBtc;
                    }

                    await u.save();
                    
                    const ch = client.channels.cache.get(CONFIG.MINER_CHANNEL);
                    if (ch) ch.send(`⚡ 🚨 **TÚLMELEGEDÉS!** <@${u.userId}> szerverterme leállt! Az eddigi termelésed (**${formatBtc(accruedBtc)}**) elmentésre került. Használd a \`/crypto szerviz\` parancsot!`).catch(() => {});
                }
            }
        } catch (e) { console.error(e); }
    }
}, 10000);

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
// 8. SLASH COMMANDS REGISTRATION
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
    new SlashCommandBuilder().setName('removeloan').setDescription('Hitel törlése (Admin)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('Felhasználó').setRequired(true))
        .addIntegerOption(o => o.setName('osszeg').setDescription('Törlendő összeg')),
    new SlashCommandBuilder().setName('removebalance').setDescription('Pénz levonása (Admin)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('Felhasználó'))
        .addNumberOption(o => o.setName('osszeg').setDescription('Összeg'))
        .addBooleanOption(o => o.setName('global').setDescription('Globális-e')),
    
    new SlashCommandBuilder().setName('addbalance').setDescription('Pénz vagy BTC adása (Admin)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false)
        .addNumberOption(o => o.setName('osszeg').setDescription('Összeg (Ft vagy BTC)').setRequired(true))
        .addStringOption(o => o.setName('currency').setDescription('Pénznem kiválasztása').addChoices(
            { name: '💵 Cash (Ft)', value: 'ft' },
            { name: '🪙 Bitcoin (BTC)', value: 'btc' }
        ))
        .addUserOption(o => o.setName('user').setDescription('Felhasználó'))
        .addBooleanOption(o => o.setName('global').setDescription('Globális-e')),

    new SlashCommandBuilder().setName('fakeban').setDescription('Troll kamu kitiltás').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Felhasználó').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Indok')),
    new SlashCommandBuilder().setName('nitro').setDescription('Ingyen Discord Nitro ajándék (kamu)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false),
    new SlashCommandBuilder().setName('mock').setDescription('Spongyabob gúnyolódó szöveg').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addStringOption(o => o.setName('text').setDescription('A szöveg').setRequired(true)),
    new SlashCommandBuilder().setName('roulette').setDescription('Orosz rulett játék (1/6 esély 1 perces némításra)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false),
    new SlashCommandBuilder().setName('roast').setDescription('Vicces beszólogatás').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Kinek szóljon?').setRequired(true)),
    new SlashCommandBuilder().setName('rate').setDescription('Értékelj bármit').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addStringOption(o => o.setName('thing').setDescription('Mit értékeljen?').setRequired(true)),

    new SlashCommandBuilder().setName('coinflip').setDescription('Párbaj egy másik játékossal (3% kaszinó jutalék)')
        .addUserOption(o => o.setName('user').setDescription('Kivel szeretnél párbajozni?').setRequired(true))
        .addIntegerOption(o => o.setName('bet').setDescription('Tét összege (Ft)').setRequired(true).setMinValue(100)),

    new SlashCommandBuilder().setName('achievements').setDescription('Mérföldkövek és elért kitüntetések lekérése').addUserOption(o => o.setName('user').setDescription('Kinek a mérföldkövei?')),
    new SlashCommandBuilder().setName('quests').setDescription('Napi küldetések és jutalmak átvétele'),

    new SlashCommandBuilder().setName('btc').setDescription('Bitcoin parancsok')
        .addSubcommand(s => s.setName('ar').setDescription('Bitcoin ára és grafikona'))
        .addSubcommand(s => s.setName('sell').setDescription('BTC eladása').addNumberOption(o => o.setName('btc').setDescription('Eladandó BTC').setRequired(true))),

    new SlashCommandBuilder().setName('miner').setDescription('Bányász bolt').addSubcommand(s => s.setName('bolt').setDescription('Bolt megnyitása')),
    new SlashCommandBuilder().setName('crypto').setDescription('Bányász farm kezelése')
        .addSubcommand(s => s.setName('farm').setDescription('Farm állapota').addUserOption(o => o.setName('user').setDescription('Melyik felhasználó farmját szeretnéd megnézni?')))
        .addSubcommand(s => s.setName('claim').setDescription('BTC begyűjtése'))
        .addSubcommand(s => s.setName('kartya-eladas').setDescription('Kártya eladása'))
        .addSubcommand(s => s.setName('szerviz').setDescription('Szerverterem javítása')),

    new SlashCommandBuilder().setName('invites').setDescription('Meghívók').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('treasure').setDescription('Kincs kikérése'),
    new SlashCommandBuilder().setName('daily').setDescription('Napi ingyen jutalom'),
    new SlashCommandBuilder().setName('weekly').setDescription('Heti ingyen jutalom'),
    new SlashCommandBuilder().setName('work').setDescription('Munkavégzés'),
    new SlashCommandBuilder().setName('bal').setDescription('Egyenleg lekérése').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('stat').setDescription('Kaszinó statisztika').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('hitel').setDescription('Banki hitel')
        .addSubcommand(s => s.setName('felvesz').setDescription('Hitel felvétele').addIntegerOption(o => o.setName('osszeg').setDescription('Összeg').setRequired(true)))
        .addSubcommand(s => s.setName('statusz').setDescription('Státusz'))
        .addSubcommand(s => s.setName('torleszt').setDescription('Törlesztés').addIntegerOption(o => o.setName('osszeg').setDescription('Összeg').setRequired(true))),
    
    new SlashCommandBuilder().setName('top').setDescription('Toplisták megtekintése')
        .addSubcommand(s => s.setName('cash').setDescription('A leggazdagabb játékosok készpénz alapján'))
        .addSubcommand(s => s.setName('crypto').setDescription('A legtöbb Bitcoinnal rendelkező játékosok')),

    new SlashCommandBuilder().setName('mines').setDescription('Mines játék').addIntegerOption(o => o.setName('bet').setDescription('Tét').setRequired(true)).addIntegerOption(o => o.setName('bombs').setDescription('Bombák').setRequired(true)),
    new SlashCommandBuilder().setName('blackjack').setDescription('Blackjack játék').addIntegerOption(o => o.setName('bet').setDescription('Tét').setRequired(true)),
    new SlashCommandBuilder().setName('iq').setDescription('IQ teszt').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('meret').setDescription('Méret teszt').addUserOption(o => o.setName('user').setDescription('Felhasználó'))
].map(c => c.toJSON());

// ==========================================
// 9. BOT READY & LISTENERS
// ==========================================
client.once('ready', async () => {
    console.log(`Sikeresen elindult: ${client.user.tag}`);
    try {
        await new REST({ version: '10' }).setToken(process.env.TOKEN).put(Routes.applicationGuildCommands(client.user.id, CONFIG.GUILD_ID), { body: commands });
        console.log('✅ Slash parancsok frissítve!');
    } catch (err) { console.error(err); }

    await syncUserGpuStats();
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

    // 🔄 TELJES SZEZON RESET PARANCS
    if (cmd === '.seasonreset') {
        if (m.author.id !== CONFIG.FIXED_USER_ID) {
            return m.reply('❌ Nincs jogosultságod a szezon reset használatához! Kizárólag a bot tulajdonosa indíthatja el.').catch(() => {});
        }

        try {
            const users = await User.find({ guildId: m.guild.id });
            for (const user of users) {
                user.balance = (user.userId === CONFIG.FIXED_USER_ID) ? 10000000 : 0;
                user.loanDebt = 0;
                user.btcBalance = 0;
                user.roomType = 'alagsor';
                user.coolerType = 'stock';
                user.rigs = [];
                user.isBroken = false;
                user.repairUntil = 0;
                user.brokenAt = 0;
                user.lastBtcClaim = Date.now();
                user.lastTreasure = 0;
                user.lastDaily = 0;
                user.lastWeekly = 0;
                user.lastWork = 0;
                user.totalMinedBtc = 0;
                user.totalLoanRepaid = 0;
                user.achievements = [];
                user.quests = {
                    lastReset: 0,
                    playBj: 0,
                    claimBtc: 0,
                    doWork: 0,
                    claimedBjReward: false,
                    claimedBtcReward: false,
                    claimedWorkReward: false
                };
                user.stats = {
                    blackjack: { played: 0, won: 0, netProfit: 0 },
                    mines: { played: 0, won: 0, netProfit: 0 }
                };
                await user.save();
            }

            const settings = await getGuildSettings(m.guild.id);
            settings.casinoLossVault = 0;
            settings.casinoWinVault = 0;
            await settings.save();

            const resetEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('🔄 TELJES SZEZON RESET VÉGREHAJTVA!')
                .setDescription('**A szerver gazdasága és bányászati rendszere teljesen újraindult!**')
                .setTimestamp();

            return m.reply({ embeds: [resetEmbed] });
        } catch (err) {
            console.error('Hiba a szezon reset során:', err);
            return m.reply('❌ Hiba történt a szezon reset végrehajtása során!').catch(() => {});
        }
    }

    // 🛑 BOT LEÁLLÍTÁS ÉS INDÍTÁS KEZELÉS (.botstop / .botstart)
    if (cmd === '.botstop' || cmd === '.botstart') {
        if (m.author.id !== CONFIG.FIXED_USER_ID) {
            return m.reply('❌ Nincs jogosultságod ehhez a parancshoz! Kizárólag a bot tulajdonosa indíthatja el vagy állíthatja le.').catch(() => {});
        }

        if (cmd === '.botstop') {
            isMaintenanceMode = true;
            updateStatus(m.guild);
            return m.reply('🛑 **BOT TELJESEN LEÁLLÍTVA!** A parancsok lezárva mindenkinek!').catch(() => {});
        } else if (cmd === '.botstart') {
            isMaintenanceMode = false;
            updateStatus(m.guild);
            return m.reply('🚀 **BOT ELINDÍTVA!** A bot újra használható!').catch(() => {});
        }
    }

    if (Math.random() < 0.015) m.react(Math.random() < 0.5 ? '🤡' : '🤓').catch(() => {});
    if (cmd === 'mikor') return m.reply('Majd ha piros hó esik! 🤡').catch(() => {});
    if (cmd === 'miért' || cmd === 'miert') return m.reply('Mert csak! 🤫').catch(() => {});

    if (['.sorsolas', '.partner', '.sima'].includes(cmd)) {
        await m.delete().catch(() => {});
        if (!m.member?.roles?.cache?.has(CONFIG.STAFF_ROLE) && m.author.id !== CONFIG.FIXED_USER_ID) {
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
// 10. REACTION & INTERACTION HANDLERS
// ==========================================
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || !reaction.message.guild) return;
    if (isMaintenanceMode) return; 
    if (reaction.emoji.name !== '✅') return;

    try {
        const game = Array.from(activeMines.values()).find(g => g.msgId === reaction.message.id);
        if (!game) return;

        if (user.id !== game.userId || game.revealed.length === 0) {
            await reaction.users.remove(user.id).catch(() => {});
            return;
        }

        activeMines.delete(game.msgId);
        const currentMult = getMinesMultiplier(25, game.bombs, game.revealed.length);
        const winAmount = Math.floor(game.bet * currentMult);
        const profit = winAmount - game.bet;

        const uDb = await getUserDb(reaction.message.guild.id, user.id);
        uDb.balance += winAmount;
        
        if (!uDb.stats) uDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };
        uDb.stats.mines.played += 1;
        uDb.stats.mines.won += 1;
        uDb.stats.mines.netProfit += profit;
        await uDb.save();

        await addWinToVault(reaction.message.guild.id, profit);

        const endEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('💰 KIFIZETÉS SIKERES!')
            .addFields(
                { name: '🏆 MEGNYERT ÖSSZEG', value: `\`\`\`${formatFt(winAmount)}\`\`\``, inline: true },
                { name: '📈 VÉGSŐ SZORZÓ', value: `\`\`\`x${currentMult.toFixed(2)}\`\`\``, inline: true },
                { name: '💳 ÚJ EGYENLEGED', value: `\`\`\`${formatFt(uDb.balance)}\`\`\``, inline: false }
            )
            .setDescription('Sikeresen kiszálltál a játékból a ✅ pipával!');

        await reaction.message.edit({ embeds: [endEmbed], components: buildMinesComponents(game, true) });
        await reaction.message.reactions.removeAll().catch(() => {});
    } catch (e) {
        console.error('Reaction hiba:', e);
    }
});

client.on('interactionCreate', async (i) => {
    if (!i.isCommand() && !i.isButton() && !i.isStringSelectMenu()) return;

    try {
        // 🔒 ZÁROLÁS 1: Karbantartás mód
        if (isMaintenanceMode) {
            return i.reply({ content: '🛑 **A BOT LE VAN ÁLLÍTVA!** Jelenleg semmilyen parancs nem használható. A tulajdonos `.botstart` parancsával indítható újra.', ephemeral: true }).catch(() => {});
        }

        // 👑 ZÁROLÁS 2: KIZÁRÓLAG A TE ID-D TUDJA HASZNÁLNI A SLASH PARANCSOKAT!
        if (i.user.id !== CONFIG.FIXED_USER_ID) {
            return i.reply({ content: '❌ **Ez a parancs kizárólag a bot tulajdonosa számára érhető el!**', ephemeral: true }).catch(() => {});
        }

        if (i.isChatInputCommand()) {
            const userDb = await getUserDb(i.guild.id, i.user.id);
            const settings = await getGuildSettings(i.guild.id);

            if (!userDb.stats) {
                userDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };
            }

            if (i.commandName === 'btc') {
                const sub = i.options.getSubcommand();

                if (sub === 'ar') {
                    await i.deferReply();

                    const diffPercent = (((settings.btcPriceFt - BASE_BTC_PRICE) / BASE_BTC_PRICE) * 100).toFixed(1);
                    const diffTag = diffPercent >= 0 ? `+${diffPercent}%` : `${diffPercent}%`;
                    
                    // ⚡ KIZÁRÓLAG AZ UTOLSÓ 5 PONT A KÉPI ÁBRÁZOLÁSHOZ
                    const history = settings.btcHistory && settings.btcHistory.length > 0 ? settings.btcHistory : [BASE_BTC_PRICE];
                    const last5 = history.slice(-5);
                    const labels = last5.map((_, idx) => `#${idx + 1}`);

                    const chartConfig = {
                        type: 'line',
                        data: {
                            labels: labels,
                            datasets: [{
                                label: 'BTC Árfolyam (Ft)',
                                data: last5,
                                borderColor: diffPercent >= 0 ? 'rgb(46, 204, 113)' : 'rgb(231, 76, 60)',
                                backgroundColor: diffPercent >= 0 ? 'rgba(46, 204, 113, 0.1)' : 'rgba(231, 76, 60, 0.1)',
                                fill: true,
                                tension: 0.3
                            }]
                        },
                        options: {
                            title: { display: true, text: 'Bitcoin Árfolyam alakulása (Utolsó 5 frissítés)' },
                            legend: { display: false }
                        }
                    };

                    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=250&bkg=transparent`;

                    const historyText = last5.map((p, idx) => `**#${idx + 1}:** ${formatFt(p)}`).join('\n');

                    const embed = new EmbedBuilder()
                        .setColor(diffPercent >= 0 ? '#2ecc71' : '#e74c3c')
                        .setTitle('📈 BITCOIN ÁRFOLYAM JELENTÉS')
                        .addFields(
                            { name: '🪙 Jelenlegi Árfolyam', value: `**1 BTC = ${formatFt(settings.btcPriceFt)}**`, inline: true },
                            { name: '📊 Változás', value: `\`\`\`diff\n${diffTag}\`\`\``, inline: true },
                            { name: '📜 Utolsó 5 Árfolyam', value: historyText || 'Nincs adatsor', inline: false }
                        )
                        .setImage(chartUrl);

                    return i.editReply({ embeds: [embed] }).catch(() => {
                        // Ha a kép betöltése meghiúsulna, elküldi kép nélkül, hogy ne ragadjon be
                        embed.setImage(null);
                        return i.editReply({ embeds: [embed] });
                    });
                }

                if (sub === 'sell') {
                    const amount = i.options.getNumber('btc');
                    if ((userDb.btcBalance || 0) < amount) {
                        return i.reply({ content: '❌ Nincs ennyi Bitcoinod!', ephemeral: true });
                    }

                    const earnFt = Math.floor(amount * settings.btcPriceFt);
                    userDb.btcBalance -= amount;
                    userDb.balance += earnFt;
                    await userDb.save();

                    return i.reply({ content: `💰 Sikeresen eladtál **${formatBtc(amount)}** Bitcoin-t **${formatFt(earnFt)}** készpénzért! (Árfolyam: ${formatFt(settings.btcPriceFt)} / BTC)`, ephemeral: true });
                }
            }

            if (i.commandName === 'miner') {
                const sub = i.options.getSubcommand();
                if (sub === 'bolt') {
                    const embed = new EmbedBuilder()
                        .setColor('#f7931a')
                        .setTitle('🛒 KRIPTOBÁNYÁSZ BOLT')
                        .setDescription('Válassz az alábbi lehetőségek közül gombok segítségével!')
                        .addFields(
                            { name: '🖥️ Videokártyák', value: 'Vásárolj bányászkártyákat a kapacitásod erejéig!', inline: true },
                            { name: '🏢 Szerverterem', value: 'Bővítsd a helyiségedet több férőhelyért és bónuszokért!', inline: true },
                            { name: '🌀 Hűtőrendszer', value: 'Vásárolj hűtést a túlmelegedés ellen!', inline: true }
                        );

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`miner_menu_gpus_${i.user.id}`).setLabel('🖥️ Videokártyák').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`miner_menu_rooms_${i.user.id}`).setLabel('🏢 Szerverterem Bővítés').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`miner_menu_coolers_${i.user.id}`).setLabel('🌀 Hűtőrendszer').setStyle(ButtonStyle.Danger)
                    );

                    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
                }
            }

            if (i.commandName === 'crypto') {
                const sub = i.options.getSubcommand();

                if (sub === 'farm') {
                    const targetUser = i.options.getUser('user') || i.user;
                    const isSelf = targetUser.id === i.user.id;
                    const targetDb = isSelf ? userDb : await getUserDb(i.guild.id, targetUser.id);

                    const roomInfo = ROOMS[targetDb.roomType || 'alagsor'];
                    const coolerInfo = COOLERS[targetDb.coolerType || 'stock'];
                    const gpuCount = targetDb.rigs ? targetDb.rigs.length : 0;
                    const now = Date.now();
                    
                    if (targetDb.isBroken && targetDb.repairUntil > 0 && targetDb.repairUntil <= now) {
                        targetDb.isBroken = false;
                        targetDb.repairUntil = 0;
                        targetDb.brokenAt = 0;
                        targetDb.lastBtcClaim = now;
                        await targetDb.save();
                    }

                    const calculationEndTime = targetDb.isBroken ? (targetDb.brokenAt || targetDb.lastBtcClaim || now) : now;
                    const hoursPassed = Math.max(0, (calculationEndTime - (targetDb.lastBtcClaim || calculationEndTime)) / (1000 * 60 * 60));

                    let btcPerHourTotal = 0;
                    if (targetDb.rigs && targetDb.rigs.length > 0) {
                        const rawBtc = targetDb.rigs.reduce((sum, r) => sum + (r.btcPerHour || 0), 0);
                        btcPerHourTotal = rawBtc * roomInfo.multiplier;
                    }
                    const minedBtc = hoursPassed * btcPerHourTotal;

                    let statusText = '🟢 **Működik**';
                    let embedColor = '#00f2fe';

                    if (targetDb.isBroken) {
                        embedColor = '#ff0000';
                        if (targetDb.repairUntil > now) {
                            const remMs = targetDb.repairUntil - now;
                            const remMin = Math.floor(remMs / (1000 * 60));
                            const remSec = Math.floor((remMs % (1000 * 60)) / 1000);
                            statusText = `🔴 **TÚLMELEGEDETT / MEGHIBÁSODOTT!**\n🛠️ **Szerelés alatt (Hátralévő idő: ${remMin} perc ${remSec} mp)**`;
                        } else {
                            statusText = '🔴 **TÚLMELEGEDETT / MEGHIBÁSODOTT!**\n⚠️ *A farm leállt, a termelés szünetel!*';
                        }
                    }

                    const finalFailChance = Math.max(0.5, ((roomInfo.failChance - coolerInfo.failReduce) * 100)).toFixed(1);

                    const embed = new EmbedBuilder()
                        .setColor(embedColor)
                        .setTitle(`⚡ ${targetUser.username} Bányász Farmja`)
                        .addFields(
                            { name: '🏢 Helyiség', value: `${roomInfo.name} (${gpuCount}/${roomInfo.maxGpus} kártya)\n*Bónusz:* **+${Math.round((roomInfo.multiplier - 1) * 100)}% termelés**`, inline: true },
                            { name: '🌀 Hűtés', value: `${coolerInfo.name}\n*Meghibásodási esély:* **${finalFailChance}% / óra**`, inline: true },
                            { name: '📊 Státusz', value: statusText, inline: false },
                            { name: '📈 Végleges Termelés', value: targetDb.isBroken ? '🔴 **0.00000000 BTC / óra (Leállva)**' : `**${formatBtcWithFt(btcPerHourTotal, settings.btcPriceFt)}** / óra`, inline: false },
                            { name: '🪙 Begyűjthető Bitcoin', value: `**${formatBtcWithFt(minedBtc, settings.btcPriceFt)}**`, inline: false },
                            { name: '💳 Egyenlegek', value: `• Wallet: **${formatBtcWithFt(targetDb.btcBalance || 0, settings.btcPriceFt)}**\n• Cash: **${formatFt(targetDb.balance)}**`, inline: false }
                        );

                    const components = [];
                    if (isSelf) {
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`miner_claim_btn_${i.user.id}`).setLabel('💰 BTC Begyűjtése').setStyle(ButtonStyle.Success).setDisabled(minedBtc <= 0)
                        );
                        components.push(row);
                    }

                    return i.reply({ embeds: [embed], components });
                }

                if (sub === 'claim') {
                    const now = Date.now();
                    const calculationEndTime = userDb.isBroken ? (userDb.brokenAt || userDb.lastBtcClaim || now) : now;
                    const hoursPassed = Math.max(0, (calculationEndTime - (userDb.lastBtcClaim || calculationEndTime)) / (1000 * 60 * 60));

                    const roomInfo = ROOMS[userDb.roomType || 'alagsor'];
                    let rawBtc = userDb.rigs ? userDb.rigs.reduce((sum, r) => sum + (r.btcPerHour || 0), 0) : 0;
                    let btcPerHourTotal = rawBtc * roomInfo.multiplier;
                    const minedBtc = hoursPassed * btcPerHourTotal;

                    if (minedBtc <= 0) return i.reply({ content: '❌ Még nincs begyűjthető Bitcoinod!', ephemeral: true });

                    userDb.btcBalance = (userDb.btcBalance || 0) + minedBtc;
                    userDb.totalMinedBtc = (userDb.totalMinedBtc || 0) + minedBtc;
                    userDb.lastBtcClaim = now;
                    if (userDb.isBroken) userDb.brokenAt = now;

                    if (!userDb.quests) userDb.quests = {};
                    userDb.quests.claimBtc = (userDb.quests.claimBtc || 0) + 1;

                    await userDb.save();
                    await checkAndGrantAchievements(userDb, i.channel);

                    return i.reply({ content: `🎉 Sikeresen begyűjtöttél **${formatBtcWithFt(minedBtc, settings.btcPriceFt)}**-t!`, ephemeral: true });
                }

                if (sub === 'kartya-eladas') {
                    if (!userDb.rigs || userDb.rigs.length === 0) {
                        return i.reply({ content: '❌ Egyetlen videokártyád sincs, amit el tudnál adni!', ephemeral: true });
                    }

                    const options = userDb.rigs.map((r, index) => {
                        const originalGpu = GPUS[r.gpuId];
                        const sellPrice = originalGpu ? Math.floor(originalGpu.price * 0.60) : 0;
                        return {
                            label: `${r.name}`,
                            value: `${index}_${r.gpuId}`,
                            description: `Visszavásárlási ár (60%): ${formatFt(sellPrice)}`
                        };
                    });

                    const select = new StringSelectMenuBuilder()
                        .setCustomId(`select_sell_gpu_${i.user.id}`)
                        .setPlaceholder('Válassz eladandó videokártyát...')
                        .addOptions(options);

                    const row = new ActionRowBuilder().addComponents(select);

                    const embed = new EmbedBuilder()
                        .setColor('#e74c3c')
                        .setTitle('🏷️ VIDEOKÁRTYA ELADÁS')
                        .setDescription('Itt eladhatod a már meglévő videokártyáidat az **eredeti ár 60%-áért**!\nVálassz egyet a menüből az eladáshoz.');

                    return i.reply({ embeds: [embed], components: [row], ephemeral: true });
                }

                if (sub === 'szerviz') {
                    if (!userDb.isBroken) return i.reply({ content: '✅ A szervertermednek semmi baja!', ephemeral: true });
                    if (userDb.repairUntil > Date.now()) return i.reply({ content: '⏳ A szerelés már folyamatban van!', ephemeral: true });
                    if (userDb.balance < 100000) return i.reply({ content: '❌ Nincs elég pénzed a szervizre! (Ára: 100 000 Ft)', ephemeral: true });

                    userDb.balance -= 100000;
                    userDb.repairUntil = Date.now() + (30 * 60 * 1000);
                    await userDb.save();

                    return i.reply({ content: '🔧 **Szerviz elindítva!** A szerverterem **30 perc múlva** újra működni fog!', ephemeral: true });
                }
            }

            if (i.commandName === 'removeloan') {
                const targetUser = i.options.getUser('user');
                const removeAmount = i.options.getInteger('osszeg');
                const targetDb = await getUserDb(i.guild.id, targetUser.id);

                if (targetDb.loanDebt <= 0) {
                    return i.reply({ content: `❌ <@${targetUser.id}> felhasználónak nincs aktív hiteltartozása!`, ephemeral: true });
                }

                if (!removeAmount || removeAmount >= targetDb.loanDebt) {
                    const oldDebt = targetDb.loanDebt;
                    targetDb.loanDebt = 0;
                    await targetDb.save();
                    return i.reply({ content: `✅ **Sikeres törlés!** <@${targetUser.id}> teljes hiteltartozása (**${formatFt(oldDebt)}**) elengedésre került!` });
                } else {
                    targetDb.loanDebt -= removeAmount;
                    await targetDb.save();
                    return i.reply({ content: `✅ **Sikeres törlesztés!** Elengedtél **${formatFt(removeAmount)}** hitelt <@${targetUser.id}> számlájáról!\n• Hátralévő tartozás: **${formatFt(targetDb.loanDebt)}**` });
                }
            }

            if (i.commandName === 'removebalance') {
                const isGlobal = i.options.getBoolean('global') || false;
                const removeAmount = i.options.getNumber('osszeg');
                const targetUser = i.options.getUser('user');

                if (isGlobal) {
                    if (!removeAmount) {
                        const result = await User.updateMany({ guildId: i.guild.id }, { $set: { balance: 0 } });
                        return i.reply({ content: `🌐 🧹 **GLOBÁLIS ADATBÁZIS RESET!** Az összes regisztrált felhasználó (${result.modifiedCount} fő) egyenlege **0 Ft**-ra lett állítva!` });
                    } else {
                        const result = await User.updateMany({ guildId: i.guild.id }, { $inc: { balance: -removeAmount } });
                        return i.reply({ content: `🌐 💸 **GLOBÁLIS LEVONÁS!** Levontál **${formatFt(removeAmount)}**-ot az összes felhasználó számlájáról (${result.modifiedCount} fő)!` });
                    }
                } else {
                    if (!targetUser) return i.reply({ content: '❌ Kérlek adj meg egy felhasználót, vagy válaszd a `global: Igaz` opciót!', ephemeral: true });

                    const targetDb = await getUserDb(i.guild.id, targetUser.id);
                    if (!removeAmount || removeAmount >= targetDb.balance) {
                        const oldBal = targetDb.balance;
                        targetDb.balance = 0;
                        await targetDb.save();
                        return i.reply({ content: `✅ **Egyenleg nullázva!** <@${targetUser.id}> teljes vagyonát (**${formatFt(oldBal)}**) levontad!` });
                    } else {
                        targetDb.balance -= removeAmount;
                        await targetDb.save();
                        return i.reply({ content: `✅ **Sikeres levonás!** Levontál **${formatFt(removeAmount)}**-ot <@${targetUser.id}> számlájáról!\n• Új egyenlege: **${formatFt(targetDb.balance)}**` });
                    }
                }
            }

            if (i.commandName === 'addbalance') {
                const addAmount = i.options.getNumber('osszeg');
                const currency = i.options.getString('currency') || 'ft';
                const isGlobal = i.options.getBoolean('global') || false;
                const targetUser = i.options.getUser('user');

                if (currency === 'btc') {
                    if (isGlobal) {
                        const result = await User.updateMany({ guildId: i.guild.id }, { $inc: { btcBalance: addAmount } });
                        return i.reply({ content: `🌐 🎁 **GLOBÁLIS BITCOIN OSZTÁS!** Minden felhasználó (${result.modifiedCount} fő) kapott **${formatBtc(addAmount)}**-t a tárcájába! 🪙` });
                    } else {
                        if (!targetUser) return i.reply({ content: '❌ Kérlek adj meg egy felhasználót, vagy válaszd a `global: Igaz` opciót!', ephemeral: true });

                        const targetDb = await getUserDb(i.guild.id, targetUser.id);
                        targetDb.btcBalance = (targetDb.btcBalance || 0) + addAmount;
                        await targetDb.save();
                        return i.reply({ content: `✅ **Sikeres BTC jóváírás!** Hozzáadtál **${formatBtc(addAmount)}**-t <@${targetUser.id}> tárcájához!\n• Új BTC egyenleg: **${formatBtc(targetDb.btcBalance)}**` });
                    }
                } else {
                    if (isGlobal) {
                        const result = await User.updateMany({ guildId: i.guild.id }, { $inc: { balance: addAmount } });
                        return i.reply({ content: `🌐 🎁 **GLOBÁLIS PÉNZOSZTÁS!** Minden regisztrált felhasználó (${result.modifiedCount} fő) kapott **${formatFt(addAmount)}**-ot az egyenlegére! 🎉` });
                    } else {
                        if (!targetUser) return i.reply({ content: '❌ Kérlek adj meg egy felhasználót, vagy válaszd a `global: Igaz` opciót!', ephemeral: true });

                        const targetDb = await getUserDb(i.guild.id, targetUser.id);
                        targetDb.balance += addAmount;
                        await targetDb.save();
                        return i.reply({ content: `✅ **Sikeres jóváírás!** Hozzáadtál **${formatFt(addAmount)}**-ot <@${targetUser.id}> számlájához!\n• Új egyenlege: **${formatFt(targetDb.balance)}**` });
                    }
                }
            }

            if (i.commandName === 'coinflip') {
                const target = i.options.getUser('user');
                const bet = i.options.getInteger('bet');

                if (target.bot || target.id === i.user.id) {
                    return i.reply({ content: '❌ Magaddal vagy bottal nem párbajozhatsz!', ephemeral: true });
                }

                if (userDb.balance < bet) {
                    return i.reply({ content: '❌ Nincs elég egyenleged a kihíváshoz!', ephemeral: true });
                }

                const targetDb = await getUserDb(i.guild.id, target.id);
                if (targetDb.balance < bet) {
                    return i.reply({ content: `❌ **${target.username}** nem rendelkezik elég pénzzel ehhez a téthez!`, ephemeral: true });
                }

                const flipId = `cf_${i.user.id}_${target.id}_${Date.now()}`;
                activeCoinflips.set(flipId, { challengerId: i.user.id, targetId: target.id, bet });

                const embed = new EmbedBuilder()
                    .setColor('#ffd700')
                    .setTitle('🪙 COINFLIP PÁRBAJ KIHÍVÁS!')
                    .setDescription(`<@${i.user.id}> kihívta <@${target.id}>-t egy **${formatFt(bet)}** tétű coinflip párbajra!\n\n*A nyertes viszi a potot (3% kaszinó jutalék levonással).*`);

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`cf_accept_${flipId}`).setLabel('✅ Elfogadás').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`cf_deny_${flipId}`).setLabel('❌ Elutasítás').setStyle(ButtonStyle.Danger)
                );

                return i.reply({ embeds: [embed], components: [row] });
            }

            if (i.commandName === 'achievements') {
                const target = i.options.getUser('user') || i.user;
                const targetDb = await getUserDb(i.guild.id, target.id);
                const userAchs = targetDb.achievements || [];

                const allAchs = [
                    { id: 'mined_1btc', name: '⛏️ Bányász Mester', desc: 'Termelj ki legalább 1.0 BTC-t!' },
                    { id: 'loan_repaid_50m', name: '🏦 Hitelmentes Gigász', desc: 'Fizess vissza összesen 50,000,000 Ft hitelt!' },
                    { id: 'mines_10_bombs', name: '💣 Aknamentesítő', desc: 'Nyerj egy legalább 10 bombás Mines kört!' },
                    { id: 'bj_wins_25', name: '♠️ Kaszinó Cápa', desc: 'Nyerj legalább 25 Blackjack meccset!' }
                ];

                let listStr = '';
                allAchs.forEach(a => {
                    const isDone = userAchs.includes(a.id);
                    listStr += `${isDone ? '✅' : '🔒'} **${a.name}**\n> *${a.desc}*\n\n`;
                });

                const embed = new EmbedBuilder()
                    .setColor('#ffd700')
                    .setTitle(`🏆 ${target.username} Mérföldkövei (${userAchs.length}/${allAchs.length})`)
                    .setDescription(listStr);

                return i.reply({ embeds: [embed] });
            }

            if (i.commandName === 'quests') {
                const todayMidnight = getBudapestMidnightMs();
                if (!userDb.quests) userDb.quests = {};

                if ((userDb.quests.lastReset || 0) < todayMidnight) {
                    userDb.quests = {
                        lastReset: todayMidnight,
                        playBj: 0,
                        claimBtc: 0,
                        doWork: 0,
                        claimedBjReward: false,
                        claimedBtcReward: false,
                        claimedWorkReward: false
                    };
                    await userDb.save();
                }

                const q = userDb.quests;
                const embed = new EmbedBuilder()
                    .setColor('#00f2fe')
                    .setTitle('🎯 NAPI KÜLDETÉSEK')
                    .setDescription('Teljesítsd a napi feladatokat az extra jutalmakért!\n\n')
                    .addFields(
                        { name: `1. Játssz 3 kör Blackjack-et (${q.playBj}/3)`, value: q.claimedBjReward ? '✅ **ÁTVÉVE** (+250 000 Ft)' : (q.playBj >= 3 ? '🎉 **TELJESÍTVE!** Kattints az átvételhez!' : '⏳ Folyamatban... (+250 000 Ft)'), inline: false },
                        { name: `2. Gyűjts be BTC-t a farmodról (${q.claimBtc}/1)`, value: q.claimedBtcReward ? '✅ **ÁTVÉVE** (+0.0005 BTC)' : (q.claimBtc >= 1 ? '🎉 **TELJESÍTVE!** Kattints az átvételhez!' : '⏳ Folyamatban... (+0.0005 BTC)'), inline: false },
                        { name: `3. Dolgozz legalább 2-szer (${q.doWork}/2)`, value: q.claimedWorkReward ? '✅ **ÁTVÉVE** (+100 000 Ft)' : (q.doWork >= 2 ? '🎉 **TELJESÍTVE!** Kattints az átvételhez!' : '⏳ Folyamatban... (+100 000 Ft)'), inline: false }
                    );

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`claim_q_bj_${i.user.id}`).setLabel('💰 1. Jutalma').setStyle(ButtonStyle.Success).setDisabled(q.playBj < 3 || q.claimedBjReward),
                    new ButtonBuilder().setCustomId(`claim_q_btc_${i.user.id}`).setLabel('🪙 2. Jutalma').setStyle(ButtonStyle.Success).setDisabled(q.claimBtc < 1 || q.claimedBtcReward),
                    new ButtonBuilder().setCustomId(`claim_q_work_${i.user.id}`).setLabel('💵 3. Jutalma').setStyle(ButtonStyle.Success).setDisabled(q.doWork < 2 || q.claimedWorkReward)
                );

                return i.reply({ embeds: [embed], components: [row] });
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

            if (['blackjack', 'mines'].includes(i.commandName)) {
                if (userDb.balance < 0) {
                    return i.reply({ content: `❌ **Kaszinózási tiltás!** Mivel az egyenleged mínuszba ment (**${formatFt(userDb.balance)}**), nem játszhatsz amíg dolgozással vagy befizetéssel egyenesbe nem jössz! 🚫`, ephemeral: true });
                }
            }

            if (i.commandName === 'daily') {
                const bpNow = getBudapestDate();
                const todayMidnight = getBudapestMidnightMs();

                if (userDb.lastDaily >= todayMidnight) {
                    const tomorrowMidnight = todayMidnight + 24 * 60 * 60 * 1000;
                    const diffMs = tomorrowMidnight - bpNow.getTime();
                    const hours = Math.floor(diffMs / (1000 * 60 * 60));
                    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                    return i.reply({ content: `⏳ Már felvetted a mai napi jutalmat! Várj még **${hours} órát és ${minutes} percet** (Budapesti éjfélig).` });
                }

                const dailyAmount = 1000000;
                userDb.balance += dailyAmount;
                userDb.lastDaily = bpNow.getTime();
                await userDb.save();
                return i.reply({ content: `🎁 Sikeresen felvedd a mai napi jutalmat: **${formatFt(dailyAmount)}** jóváírva az egyenlegeden! 🎉` });
            }

            if (i.commandName === 'weekly') {
                const bpNow = getBudapestDate().getTime();
                const weekMs = 7 * 24 * 60 * 60 * 1000;

                if (bpNow - userDb.lastWeekly < weekMs) {
                    const diffMs = weekMs - (bpNow - userDb.lastWeekly);
                    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    return i.reply({ content: `⏳ A heti jutalmat csak 7 naponta veheted fel! Várj még **${days} napot és ${hours} órát**.` });
                }

                const weeklyAmount = 10000000;
                userDb.balance += weeklyAmount;
                userDb.lastWeekly = bpNow;
                await userDb.save();
                return i.reply({ content: `🌟 Sikeresen felvedd a heti nagylelkű jutalmat: **${formatFt(weeklyAmount)}** jóváírva az egyenlegeden! 🚀` });
            }

            if (i.commandName === 'work') {
                const now = Date.now();
                const cd = 60 * 1000;
                if (now - userDb.lastWork < cd) {
                    const remainingSec = Math.ceil((cd - (now - userDb.lastWork)) / 1000);
                    return i.reply({ content: `⏳ Pihenj még **${remainingSec} másodpercet** a következő munka előtt.`, ephemeral: true });
                }

                const workAmount = Math.floor(Math.random() * (25000 - 10000 + 1)) + 10000;
                userDb.balance += workAmount;
                userDb.lastWork = now;
                
                if (!userDb.quests) userDb.quests = {};
                userDb.quests.doWork = (userDb.quests.doWork || 0) + 1;
                await userDb.save();

                const jobs = [
                    `Sikeresen kiszállítottál egy csomagot, és kaptál **${formatFt(workAmount)}**-ot! 📦`,
                    `Ledolgoztál egy műszakot a vándorkereskedőnél, a fizetésed: **${formatFt(workAmount)}**! 🛒`,
                    `Felsöpörtél a kaszinóban, a jutalmad: **${formatFt(workAmount)}**! 🧹`,
                    `Besegítettél a szerver karbantartásába, kaptál **${formatFt(workAmount)}**-ot! 🛠️`,
                    `💻 Illegális kripto bányászatot futtattál a szerver alagsorában, és bányásztál **${formatFt(workAmount)}**-ot! ⚡`
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
                const amount = isSuperChest ? 100000 : Math.floor(Math.random() * 15000) + 10000;

                userDb.balance += amount;
                userDb.lastTreasure = now;
                await userDb.save();

                if (isSuperChest) return i.reply({ content: `✨ **SZUPER LÁDA JACKPOT!** ✨ Ritka kincset találtál: **${formatFt(amount)}** íródott jóvá az egyenlegeden! 🎉` });
                else return i.reply({ content: `🪙 Kinyitottad a ládát és találtál benne: **${formatFt(amount)}**-ot!` });
            }

            if (i.commandName === 'bal') {
                const target = i.options.getUser('user') || i.user;
                const targetDb = await getUserDb(i.guild.id, target.id);
                return i.reply({ content: `💳 **${target.username}** egyenlege:\n• Cash: **${formatFt(targetDb.balance)}** ${targetDb.loanDebt > 0 ? `(Hitel tartozás: ${formatFt(targetDb.loanDebt)})` : ''}\n• Bitcoin: **${formatBtcWithFt(targetDb.btcBalance || 0, settings.btcPriceFt)}**` });
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

                const overallDiffTag = overallProfit >= 0 ? `+${formatFt(overallProfit)}` : `-${formatFt(Math.abs(overallProfit))}`;
                const bjDiffTag = s.blackjack.netProfit >= 0 ? `+${formatFt(s.blackjack.netProfit)}` : `-${formatFt(Math.abs(s.blackjack.netProfit))}`;
                const minesDiffTag = s.mines.netProfit >= 0 ? `+${formatFt(s.mines.netProfit)}` : `-${formatFt(Math.abs(s.mines.netProfit))}`;

                const embed = new EmbedBuilder()
                    .setColor('#00f2fe')
                    .setTitle(`📊 Kaszinó Statisztika: ${target.username}`)
                    .addFields(
                        { name: '🌐 Összesített Áttekintés', value: `> 📈 **Nyerési arány:** ${overallWinRate}%\n> 🎮 **Lejátszott körök:** ${totalPlayed} db\n> 💰 **Profit:** \`\`\`diff\n${overallDiffTag}\`\`\``, inline: false },
                        { name: '♠️ Blackjack Statisztika', value: `• **Arány:** ${bjWinRate}% (${s.blackjack.won}/${s.blackjack.played})\n• **Profit:** \`\`\`diff\n${bjDiffTag}\`\`\``, inline: true },
                        { name: '💣 Mines Statisztika', value: `• **Arány:** ${minesWinRate}% (${s.mines.won}/${s.mines.played})\n• **Profit:** \`\`\`diff\n${minesDiffTag}\`\`\``, inline: true }
                    );

                return i.reply({ embeds: [embed] });
            }

            if (i.commandName === 'hitel') {
                const sub = i.options.getSubcommand();

                if (sub === 'felvesz') {
                    if (userDb.loanDebt > 0 || userDb.balance < 0) {
                        return i.reply({ content: `❌ Már van egy aktív hiteled (**${formatFt(userDb.loanDebt)}**) vagy mínuszos az egyenleged! Előbb fizesd vissza.`, ephemeral: true });
                    }

                    const amount = i.options.getInteger('osszeg');
                    if (amount > 50000000) return i.reply({ content: `❌ Legfeljebb 50 000 000 Ft hitelt vehetsz fel!`, ephemeral: true });

                    const debtWithInterest = Math.floor(amount * 1.10);
                    userDb.balance += amount;
                    userDb.loanDebt = debtWithInterest; 
                    await userDb.save();

                    return i.reply({ content: `🏦 Sikeresen felvettél **${formatFt(amount)}** hitelt! Jóváírva az egyenlegeden.\n📈 **Kamat (10%):** ${formatFt(debtWithInterest - amount)}\n📋 **Összes visszafizetendő:** **${formatFt(debtWithInterest)}**` });
                }

                if (sub === 'statusz') {
                    return i.reply({ content: `📋 **Hitel Státuszod:**\n• Egyenleg: **${formatFt(userDb.balance)}**\n• Visszafizetendő tartozás (kamatostul): **${formatFt(userDb.loanDebt)}**` });
                }

                if (sub === 'torleszt') {
                    const amount = i.options.getInteger('osszeg');
                    if (userDb.loanDebt <= 0) return i.reply({ content: `❌ Nincs aktív hiteltartozásod!`, ephemeral: true });
                    if (userDb.balance < amount) return i.reply({ content: `❌ Nincs elég pénzed a zsebedben ehhez a törlesztéshez!`, ephemeral: true });

                    const payAmount = Math.min(amount, userDb.loanDebt);
                    userDb.balance -= payAmount;
                    userDb.loanDebt -= payAmount;
                    userDb.totalLoanRepaid = (userDb.totalLoanRepaid || 0) + payAmount;

                    await userDb.save();
                    await checkAndGrantAchievements(userDb, i.channel);

                    return i.reply({ content: `✅ Sikeresen törlesztettél **${formatFt(payAmount)}**-ot a hiteledből!\n• Hátralévő tartozás: **${formatFt(userDb.loanDebt)}**\n• Új egyenleg: **${formatFt(userDb.balance)}**` });
                }
            }

            if (i.commandName === 'top') {
                const sub = i.options.getSubcommand();

                if (sub === 'cash') {
                    const topUsers = await User.find({ guildId: i.guild.id }).sort({ balance: -1 }).limit(10);
                    const totalLoss = settings.casinoLossVault || 0;
                    const totalWin = settings.casinoWinVault || 0;

                    let desc = `🔴 **Globális kaszinó veszteség:** \`\`\`diff\n-${formatFt(totalLoss)}\`\`\`\n`;
                    desc += `🟢 **Globális kaszinó nyeremény:** \`\`\`diff\n+${formatFt(totalWin)}\`\`\`\n`;
                    desc += `👑 **A leggazdagabb tagok (Cash):**\n`;
                    
                    topUsers.forEach((u, index) => {
                        desc += `**${index + 1}.** <@${u.userId}> — **${formatFt(u.balance)}**\n`;
                    });

                    const embed = new EmbedBuilder()
                        .setColor('#ffd700')
                        .setTitle('🏆 Szerver Pénzügyi Toplista & Kaszinó Statisztika')
                        .setDescription(desc || 'Még senkinek sincs pénze.');
                    
                    return i.reply({ embeds: [embed] });
                }

                if (sub === 'crypto') {
                    const topCryptoUsers = await User.find({ guildId: i.guild.id, btcBalance: { $gt: 0 } }).sort({ btcBalance: -1 }).limit(10);

                    let desc = `🪙 **A 10 legtöbb Bitcoin-nal rendelkező bányász:**\n\n`;
                    if (topCryptoUsers.length === 0) {
                        desc += '*Még egyetlen játékos sem rendelkezik Bitcoin-nal.*';
                    } else {
                        topCryptoUsers.forEach((u, index) => {
                            desc += `**${index + 1}.** <@${u.userId}> — **${formatBtcWithFt(u.btcBalance || 0, settings.btcPriceFt)}**\n`;
                        });
                    }

                    const embed = new EmbedBuilder()
                        .setColor('#f7931a')
                        .setTitle('🪙 Szerver Top Kripto Bányászok')
                        .setDescription(desc);

                    return i.reply({ embeds: [embed] });
                }
            }

            if (i.commandName === 'mines') {
                const bet = i.options.getInteger('bet');
                const bombs = i.options.getInteger('bombs');
                if (userDb.balance < bet) return i.reply({ content: '❌ Nincs elég egyenleged a játék elindításához!', ephemeral: true });

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

                const msg = await i.reply({ embeds: [embed], components: rows, fetchReply: true });
                game.msgId = msg.id;
                await msg.react('✅');

                activeMines.set(msg.id, game);
                return;
            }

            if (i.commandName === 'blackjack') {
                const bet = i.options.getInteger('bet');
                if (userDb.balance < bet) return i.reply({ content: '❌ Nincs elég egyenleged ehhez a téthez!', ephemeral: true });

                userDb.balance -= bet;
                if (!userDb.quests) userDb.quests = {};
                userDb.quests.playBj = (userDb.quests.playBj || 0) + 1;
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

                    await addWinToVault(i.guild.id, profit);
                    await checkAndGrantAchievements(userDb, i.channel);

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

            if (['iq', 'meret'].includes(i.commandName)) {
                if (i.commandName === 'iq') {
                    const target = i.options.getUser('user') || i.user;
                    const iqVal = Math.floor(Math.random() * 251) - 50;
                    let comment = iqVal < 0 ? "Néha elfelejt levegőt venni. 🧠❌" : (iqVal < 50 ? "A gombalevest is villával eszi. 🥣" : (iqVal < 100 ? "Nem a legélesebb kés a fiókban. 🗡️" : "Smart koponya! 💡"));
                    return i.reply({ content: `🧠 **<@${target.id}>** IQ teszt eredménye: **${iqVal} IQ**\n*Értékelés:* ${comment}` });
                } else if (i.commandName === 'meret') {
                    const target = i.options.getUser('user') || i.user;
                    const sizeNum = Math.floor(Math.random() * 30) + 1;
                    return i.reply({ content: `🍆 **<@${target.id}>** fasz mérete: **8${'='.repeat(sizeNum)}D** (${sizeNum} cm)` });
                }
            }

            if (['fakeban', 'nitro', 'mock', 'roulette', 'roast', 'rate'].includes(i.commandName)) {
                if (i.commandName === 'fakeban') {
                    const user = i.options.getUser('user');
                    const reason = i.options.getString('reason') || 'Nincs megadva';
                    const banEmbed = new EmbedBuilder().setColor('#ff0000').setTitle('🔨 Tag Kitiltva!').setDescription(`**Felhasználó:** <@${user.id}>\n**Indok:** ${reason}\n**Moderátor:** Adminisztráció`);
                    await i.reply({ embeds: [banEmbed] });
                    setTimeout(() => i.editReply({ embeds: [new EmbedBuilder().setColor('#ffaa00').setTitle('🤡 CSAK VICCELTEM!').setDescription(`**<@${user.id}>** nem lett kitiltva, maradhatsz! 🎉`)] }).catch(() => {}), 3000);
                } else if (i.commandName === 'nitro') {
                    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎁 Discord Nitro Gift!').setDescription('Nyertél 1 hónap Discord Nitro-t! Kattints az alábbi gombra az átvételhez!').setThumbnail('https://i.imgur.com/264293f.png');
                    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('claim_fake_nitro').setLabel('🎁 Claim Nitro').setStyle(ButtonStyle.Success));
                    return i.reply({ embeds: [embed], components: [btn] });
                } else if (i.commandName === 'mock') {
                    const mocked = i.options.getString('text').split('').map((c, idx) => idx % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
                    return i.reply({ content: `${mocked} 🤡` });
                } else if (i.commandName === 'roulette') {
                    if (Math.floor(Math.random() * 6) === 0) {
                        await i.member.timeout(60 * 1000, 'Orosz rulett vesztes').catch(() => {});
                        return i.reply({ content: `💥 **BANG!** <@${i.user.id}> meghúzta a ravaszt, a fegyver eldördült! (1 perc némítás) 🪦` });
                    } else {
                        return i.reply({ content: `*KIKK...* <@${i.user.id}> meghúzta a ravaszt, a fegyver nem sült el. Túlélte! 🎯` });
                    }
                } else if (i.commandName === 'roast') {
                    const target = i.options.getUser('user');
                    const roasts = ["Mikor Isten az észt osztotta, te valószínűleg a sor végén álltál egy törött csészével. ☕", "Olyan vagy, mint a felhős idő: ha eltűnsz, mindenkinek szebb lesz a napja. ☀️", "Ha az ostobaság fájna, egész nap üvöltenél. 🔊"];
                    return i.reply({ content: `🔥 **<@${target.id}>**: ${roasts[Math.floor(Math.random() * roasts.length)]}` });
                } else if (i.commandName === 'rate') {
                    const rating = Math.floor(Math.random() * 10) + 1;
                    return i.reply({ content: `⭐ Értékelés: **"${i.options.getString('thing')}"**\n📊 Eredmény: **${rating}/10**` });
                }
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

                    const embed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎁 Nyereményjáték 🎁').setDescription('Reagálj a 🎉 emojival!').addFields({ name: 'Nyeremény', value: prize }, { name: 'Nyertesok', value: `${winners}`, inline: true }, { name: 'Indította', value: `<@${i.user.id}>`, inline: true }, { name: 'Lejárat', value: `<t:${endTime}:f>` });
                    if (bonus > 0) embed.addFields({ name: '💎 Booster Bónusz', value: `+${bonus}% esély` });

                    const msg = await i.reply({ embeds: [embed], fetchReply: true });
                    await msg.react('🎉');

                    const newGw = new Giveaway({ messageId: msg.id, channelId: i.channelId, guildId: i.guildId, endTime: Date.now() + durMs, prize, winnerCount: winners, boosterBonus: bonus });
                    await newGw.save();
                    setTimeout(() => endGiveaway(newGw), durMs);
                } else if (sub === 'reroll') {
                    const msgId = i.options.getString('message_id');
                    const count = i.options.getInteger('winners') || 1;
                    const gwData = await Giveaway.findOne({ messageId: msgId });
                    if (!gwData) return i.reply({ content: '❌ Nem található!', ephemeral: true });

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
                    if (!validUsers.length) return i.reply({ content: '❌ Nincs érvényes jelentkező!', ephemeral: true });

                    const members = await i.guild.members.fetch({ user: validUsers }).catch(() => new Map());
                    const participants = validUsers.map(uId => ({ id: uId, weight: members.get(uId)?.premiumSince ? 100 + gwData.boosterBonus : 100 }));
                    const winners = drawWinners(participants, count);
                    const mentions = winners.map(id => `<@${id}>`).join(' ');

                    await ch.send(`🎲 **Újrasorsolás (${winners.length} új nyertes)!** Nyeremény: **${gwData.prize}**!\n\n${mentions}`);
                    return i.reply({ content: `✅ Kisorsolva ${winners.length} új nyertes!`, ephemeral: true });
                } else if (sub === 'end') {
                    const msgId = i.options.getString('message_id');
                    const gwData = await Giveaway.findOne({ messageId: msgId });
                    if (!gwData) return i.reply({ content: '❌ Nem található!', ephemeral: true });
                    gwData.ended = false;
                    await endGiveaway(gwData);
                    return i.reply({ content: '✅ Lezárva és kisorsolva!', ephemeral: true });
                }
            }
        }

        // ==========================================
        // GOMB- ÉS MENÜINTERAKCIÓK
        // ==========================================
        if (i.isButton()) {
            const userDb = await getUserDb(i.guild.id, i.user.id);
            const settings = await getGuildSettings(i.guild.id);

            if (i.customId.startsWith('miner_claim_btn_')) {
                const ownerId = i.customId.replace('miner_claim_btn_', '');
                if (ownerId !== i.user.id) {
                    return i.reply({ content: '❌ Ez nem a te bányász farmod! Nyiss egy sajátot a `/crypto farm` parancssal! 🤡', ephemeral: true });
                }

                const now = Date.now();
                const calculationEndTime = userDb.isBroken ? (userDb.brokenAt || userDb.lastBtcClaim || now) : now;
                const hoursPassed = Math.max(0, (calculationEndTime - (userDb.lastBtcClaim || calculationEndTime)) / (1000 * 60 * 60));

                const roomInfo = ROOMS[userDb.roomType || 'alagsor'];
                let rawBtc = userDb.rigs ? userDb.rigs.reduce((sum, r) => sum + (r.btcPerHour || 0), 0) : 0;
                let btcPerHourTotal = rawBtc * roomInfo.multiplier;
                const minedBtc = hoursPassed * btcPerHourTotal;

                if (minedBtc <= 0) return i.reply({ content: '❌ Nincs begyűjthető Bitcoin!', ephemeral: true });

                userDb.btcBalance = (userDb.btcBalance || 0) + minedBtc;
                userDb.lastBtcClaim = now;
                if (userDb.isBroken) userDb.brokenAt = now;
                await userDb.save();

                const disabledRow = new ActionRowBuilder().addComponents(
                    ButtonBuilder.from(i.message.components[0].components[0]).setDisabled(true)
                );
                await i.message.edit({ components: [disabledRow] }).catch(() => {});

                return i.reply({ content: `🎉 Sikeresen begyűjtöttél **${formatBtcWithFt(minedBtc, settings.btcPriceFt)}**-t!`, ephemeral: true });
            }

            if (i.customId.startsWith('miner_')) {
                const parts = i.customId.split('_');
                const ownerId = parts[parts.length - 1];

                if (ownerId && ownerId !== i.user.id) {
                    return i.reply({ content: '❌ Ez nem a te bányász bolton! Nyiss egy sajátot a `/miner bolt` parancssal! 🤡', ephemeral: true });
                }
            }

            if (i.customId.startsWith('miner_menu_gpus')) {
                const select = new StringSelectMenuBuilder()
                    .setCustomId(`select_gpu_rarity_${i.user.id}`)
                    .setPlaceholder('Válassz ritkasági kategóriát...')
                    .addOptions([
                        { label: 'Common (Gyakori)', value: 'common', description: 'Olcsó belépő szintű kártyák' },
                        { label: 'Rare (Ritka)', value: 'rare', description: 'Megbízható középkategória' },
                        { label: 'Epic (Epikus)', value: 'epic', description: 'Nagy teljesítményű rigek' },
                        { label: 'Legendary (Legendás)', value: 'legendary', description: 'Ipari bányász monstrumok' },
                        { label: 'Mythic (Isteni)', value: 'mythic', description: 'Kvantum és AI gyorsítók' }
                    ]);

                const row1 = new ActionRowBuilder().addComponents(select);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_back_main_${i.user.id}`).setLabel('◀️ Vissza a főmenübe').setStyle(ButtonStyle.Secondary)
                );

                return i.update({ embeds: [new EmbedBuilder().setColor('#f7931a').setTitle('🖥️ VIDEOKÁRTYA KATEGÓRIÁK').setDescription('Válassz ki egy kategóriát a gördülőmenüből!')], components: [row1, row2] });
            }

            if (i.customId.startsWith('miner_menu_rooms')) {
                const embed = new EmbedBuilder()
                    .setColor('#00f2fe')
                    .setTitle('🏢 SZERVERTEREM BŐVÍTÉS')
                    .setDescription('Vásárolj nagyobb helyiséget több helyért, kevesebb meghibásodásért és extra bónuszért!')
                    .addFields(
                        { name: '🏠 Garázs Rig', value: `Ár: **${formatFt(5000000)}** | Férőhely: **12 db** | Hiba: **8%/óra** | Bónusz: **+10%**`, inline: false },
                        { name: '🏢 Hivatalos Szerverterem', value: `Ár: **${formatFt(35000000)}** | Férőhely: **25 db** | Hiba: **5%/óra** | Bónusz: **+25%**`, inline: false },
                        { name: '⚡ Ipari Adatközpont', value: `Ár: **${formatFt(150000000)}** | Férőhely: **50 db** | Hiba: **3%/óra** | Bónusz: **+50%**`, inline: false }
                    );

                const select = new StringSelectMenuBuilder()
                    .setCustomId(`select_buy_room_${i.user.id}`)
                    .setPlaceholder('Válassz szobát a megvásárláshoz...')
                    .addOptions([
                        { label: `Garázs Rig (${formatFt(5000000)})`, value: 'garazs' },
                        { label: `Hivatalos Szerverterem (${formatFt(35000000)})`, value: 'szerver' },
                        { label: `Ipari Adatközpont (${formatFt(150000000)})`, value: 'adatkozpont' }
                    ]);

                const row1 = new ActionRowBuilder().addComponents(select);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_back_main_${i.user.id}`).setLabel('◀️ Vissza a főmenübe').setStyle(ButtonStyle.Secondary)
                );

                return i.update({ embeds: [embed], components: [row1, row2] });
            }

            if (i.customId.startsWith('miner_menu_coolers')) {
                const embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('🌀 HŰTŐRENDSZER BOLT')
                    .setDescription('Vásárolj jobb hűtést a szervertermedhez a meghibásodási esély lecsökkentésére!')
                    .addFields(
                        { name: '❄️ Gyári Léghűtés (Alapértelmezett)', value: 'Ár: **Ingyenes** | Esély csökkentés: **0%**', inline: false },
                        { name: '🌀 Dupla Ventilátoros Hűtés', value: `Ár: **${formatFt(150000)}** | Esély csökkentés: **-1.0% / óra**`, inline: false },
                        { name: '🌊 Vízhűtéses AIO Rendszer', value: `Ár: **${formatFt(1500000)}** | Esély csökkentés: **-2.0% / óra**`, inline: false },
                        { name: '❄️ Ipari Klímarendszer', value: `Ár: **${formatFt(10000000)}** | Esély csökkentés: **-3.0% / óra**`, inline: false },
                        { name: '🧪 Kvantum Folyadékhűtés', value: `Ár: **${formatFt(50000000)}** | Esély csökkentés: **-4.0% / óra**`, inline: false }
                    );

                const select = new StringSelectMenuBuilder()
                    .setCustomId(`select_buy_cooler_${i.user.id}`)
                    .setPlaceholder('Válassz hűtőrendszert...')
                    .addOptions([
                        { label: 'Dupla Ventilátor (-1.0% hiba esély)', value: 'dual_fan', description: `Ár: ${formatFt(150000)}` },
                        { label: 'Vízhűtéses AIO Rendszer (-2.0% hiba esély)', value: 'water', description: `Ár: ${formatFt(1500000)}` },
                        { label: 'Ipari Klímarendszer (-3.0% hiba esély)', value: 'ac_unit', description: `Ár: ${formatFt(10000000)}` },
                        { label: 'Kvantum Folyadékhűtés (-4.0% hiba esély)', value: 'quantum_cooling', description: `Ár: ${formatFt(50000000)}` }
                    ]);

                const row1 = new ActionRowBuilder().addComponents(select);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_back_main_${i.user.id}`).setLabel('◀️ Vissza a főmenübe').setStyle(ButtonStyle.Secondary)
                );

                return i.update({ embeds: [embed], components: [row1, row2] });
            }

            if (i.customId.startsWith('miner_back_main')) {
                const embed = new EmbedBuilder()
                    .setColor('#f7931a')
                    .setTitle('🛒 KRIPTOBÁNYÁSZ BOLT')
                    .setDescription('Válassz az alábbi lehetőségek közül gombok segítségével!')
                    .addFields(
                        { name: '🖥️ Videokártyák', value: 'Vásárolj bányászkártyákat a kapacitásod erejéig!', inline: true },
                        { name: '🏢 Szerverterem', value: 'Bővítsd a helyiségedet több férőhelyért és bónuszokért!', inline: true },
                        { name: '🌀 Hűtőrendszer', value: 'Vásárolj hűtést a túlmelegedés ellen!', inline: true }
                    );

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_menu_gpus_${i.user.id}`).setLabel('🖥️ Videokártyák').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`miner_menu_rooms_${i.user.id}`).setLabel('🏢 Szerverterem Bővítés').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`miner_menu_coolers_${i.user.id}`).setLabel('🌀 Hűtőrendszer').setStyle(ButtonStyle.Danger)
                );

                return i.update({ embeds: [embed], components: [row] });
            }

            if (i.customId === 'bj_hit' || i.customId === 'bj_stand') {
                const game = activeBlackjack.get(i.message.id);
                if (!game) return i.reply({ content: '❌ Ez a játék már véget ért!', ephemeral: true });
                if (i.user.id !== game.userId) return i.reply({ content: '❌ Ez nem a te kártyapartid! 🤡', ephemeral: true });

                if (i.customId === 'bj_hit') {
                    game.playerCards.push(getRandomCard());
                    const playerSum = calculateHand(game.playerCards);

                    if (playerSum > 21) {
                        game.gameOver = true;
                        activeBlackjack.delete(i.message.id);
                        await addLossToVault(i.guild.id, game.bet);

                        userDb.stats.blackjack.played += 1;
                        userDb.stats.blackjack.netProfit -= game.bet;
                        await userDb.save();

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
                    userDb.stats.blackjack.played += 1;

                    if (dealerSum > 21 || playerSum > dealerSum) {
                        embedColor = '#00ff00';
                        const wonAmount = game.bet * 2;
                        userDb.balance += wonAmount;
                        userDb.stats.blackjack.won += 1;
                        userDb.stats.blackjack.netProfit += game.bet;
                        resultText = `🎉 **NYERTÉL!** Kaptál **${formatFt(wonAmount)}**-ot!`;
                        await addWinToVault(i.guild.id, game.bet);
                        await checkAndGrantAchievements(userDb, i.channel);
                    } else if (playerSum === dealerSum) {
                        embedColor = '#ffd700';
                        userDb.balance += game.bet;
                        resultText = `🤝 **DÖNTETLEN (Push)!** Visszakaptad a téted.`;
                    } else {
                        embedColor = '#ff0000';
                        userDb.stats.blackjack.netProfit -= game.bet;
                        resultText = `😢 **VESZTETTÉL!** Az osztó nyert.`;
                        await addLossToVault(i.guild.id, game.bet);
                    }
                    await userDb.save();

                    const finalEmbed = new EmbedBuilder()
                        .setColor(embedColor)
                        .setTitle('♠️ BLACKJACK - VÉGEREDMÉNY ♣️')
                        .setDescription(resultText)
                        .addFields(
                            { name: '🧑 Játékos lapjai', value: `\`\`\`css\n${game.playerCards.map(c => c.display).join(' ')} (Összeg: ${playerSum})\`\`\``, inline: false },
                            { name: '🤖 Osztó lapjai', value: `\`\`\`css\n${game.dealerCards.map(c => c.display).join(' ')} (Összeg: ${dealerSum})\`\`\``, inline: false },
                            { name: '💳 Új egyenleged', value: `\`\`\`${formatFt(userDb.balance)}\`\`\``, inline: true }
                        );
                    return i.update({ embeds: [finalEmbed], components: [] });
                }
            }

            if (i.customId.startsWith('mine_tile_')) {
                const game = activeMines.get(i.message.id);
                if (!game || i.user.id !== game.userId) return i.reply({ content: '❌ Ez nem a te játékod!', ephemeral: true });

                const idx = parseInt(i.customId.split('_')[2]);
                if (game.revealed.includes(idx)) return i.deferUpdate();

                if (game.grid[idx] === '💣') {
                    activeMines.delete(i.message.id);
                    await addLossToVault(i.guild.id, game.bet);

                    userDb.stats.mines.played += 1;
                    userDb.stats.mines.netProfit -= game.bet;
                    await userDb.save();

                    const loseEmbed = new EmbedBuilder().setColor('#ff0000').setTitle('💥 BUMM! AKNÁRA LÉPTÉL!').addFields({ name: '💸 ELVESZÍTETT TÉT', value: `\`\`\`${formatFt(game.bet)}\`\`\``, inline: true });
                    return i.update({ embeds: [loseEmbed], components: buildMinesComponents(game, true) });
                }

                game.revealed.push(idx);
                const currentMult = getMinesMultiplier(25, game.bombs, game.revealed.length);
                const currentWin = Math.floor(game.bet * currentMult);
                return i.update({ embeds: [createMinesEmbed(game.bet, game.bombs, game.revealed.length, currentMult, currentWin)], components: buildMinesComponents(game, false) });
            }

            if (i.customId.startsWith('cf_accept_') || i.customId.startsWith('cf_deny_')) {
                const flipId = i.customId.replace('cf_accept_', '').replace('cf_deny_', '');
                const flip = activeCoinflips.get(flipId);

                if (!flip) return i.reply({ content: '❌ Ez a kihívás már lejárt vagy érvénytelen!', ephemeral: true });
                if (i.user.id !== flip.targetId) return i.reply({ content: '❌ Nem neked címezték ezt a kihívást!', ephemeral: true });

                if (i.customId.startsWith('cf_deny_')) {
                    activeCoinflips.delete(flipId);
                    return i.update({ content: `❌ <@${i.user.id}> elutasította a coinflip párbajt!`, embeds: [], components: [] });
                }

                const challengerDb = await getUserDb(i.guild.id, flip.challengerId);

                if (challengerDb.balance < flip.bet || userDb.balance < flip.bet) {
                    activeCoinflips.delete(flipId);
                    return i.update({ content: `❌ Valamelyik félnek már nincs elég egyenlege a párbaj lefolytatásához!`, embeds: [], components: [] });
                }

                const winnerId = Math.random() < 0.5 ? flip.challengerId : flip.targetId;
                const loserId = winnerId === flip.challengerId ? flip.targetId : flip.challengerId;

                const totalPot = flip.bet * 2;
                const fee = Math.floor(totalPot * 0.03);
                const finalWin = totalPot - fee;

                const winnerDb = await getUserDb(i.guild.id, winnerId);
                const loserDb = await getUserDb(i.guild.id, loserId);

                winnerDb.balance += (finalWin - flip.bet);
                loserDb.balance -= flip.bet;

                await winnerDb.save();
                await loserDb.save();
                await addLossToVault(i.guild.id, fee);

                activeCoinflips.delete(flipId);

                const resultEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('🪙 COINFLIP PÁRBAJ VÉGEREDMÉNY!')
                    .setDescription(`🏆 **GYŐZTES:** <@${winnerId}>\n💀 **VESZTES:** <@${loserId}>\n\n💰 **Nyeremény:** **${formatFt(finalWin)}** *(Levont kaszinó jutalék 3%: ${formatFt(fee)})*`);

                return i.update({ embeds: [resultEmbed], components: [] });
            }

            if (i.customId.startsWith('claim_q_')) {
                const q = userDb.quests;
                if (i.customId.startsWith('claim_q_bj_')) {
                    if (q.playBj >= 3 && !q.claimedBjReward) {
                        q.claimedBjReward = true;
                        userDb.balance += 250000;
                        await userDb.save();
                        return i.reply({ content: '🎉 Átvetted a Blackjack küldetés jutalmát: **250 000 Ft**!', ephemeral: true });
                    }
                } else if (i.customId.startsWith('claim_q_btc_')) {
                    if (q.claimBtc >= 1 && !q.claimedBtcReward) {
                        q.claimedBtcReward = true;
                        userDb.btcBalance = (userDb.btcBalance || 0) + 0.0005;
                        await userDb.save();
                        return i.reply({ content: '🎉 Átvetted a Bányász küldetés jutalmát: **0.0005 BTC**!', ephemeral: true });
                    }
                } else if (i.customId.startsWith('claim_q_work_')) {
                    if (q.doWork >= 2 && !q.claimedWorkReward) {
                        q.claimedWorkReward = true;
                        userDb.balance += 100000;
                        await userDb.save();
                        return i.reply({ content: '🎉 Átvetted a Munkás küldetés jutalmát: **100 000 Ft**!', ephemeral: true });
                    }
                }
            }

            if (i.customId === 'claim_fake_nitro') return i.reply({ content: `🎉 **<@${i.user.id}>** bedőlt a kamu Nitrónak! 🤡` });

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
                const isOwner = (i.user.id === CONFIG.FIXED_USER_ID);
                if (!i.member?.roles?.cache?.has(CONFIG.STAFF_ROLE) && !isOwner) return i.reply({ content: '❌ Nincs jogod!', ephemeral: true });
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

        if (i.isStringSelectMenu()) {
            const userDb = await getUserDb(i.guild.id, i.user.id);
            const settings = await getGuildSettings(i.guild.id);

            if (i.customId.startsWith('select_')) {
                const parts = i.customId.split('_');
                const ownerId = parts[parts.length - 1];

                if (ownerId && ownerId !== i.user.id) {
                    return i.reply({ content: '❌ Ez nem a te bányász bolton! Nyiss egy sajátot a `/miner bolt` parancssal! 🤡', ephemeral: true });
                }
            }

            if (i.customId.startsWith('select_gpu_rarity')) {
                const rarity = i.values[0];
                const filteredGpus = Object.values(GPUS).filter(g => g.rarity === rarity);

                const options = filteredGpus.map(g => ({
                    label: `${g.name} (${formatFt(g.price)})`,
                    value: g.id,
                    description: `Termelés: ${formatBtcWithFt(g.btcPerHour, settings.btcPriceFt)} / óra`
                }));

                const select = new StringSelectMenuBuilder()
                    .setCustomId(`select_buy_gpu_${i.user.id}`)
                    .setPlaceholder('Válassz kártyát a megvásárláshoz...')
                    .addOptions(options);

                const row1 = new ActionRowBuilder().addComponents(select);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_back_main_${i.user.id}`).setLabel('◀️ Vissza a kategóriákhoz').setStyle(ButtonStyle.Secondary)
                );

                return i.update({ embeds: [new EmbedBuilder().setColor('#f7931a').setTitle(`🖥️ ${rarity.toUpperCase()} KÁRTYÁK`).setDescription('Válaszd ki a megvásárolni kívánt modellt!')], components: [row1, row2] });
            }

            if (i.customId.startsWith('select_buy_gpu')) {
                const gpuId = i.values[0];
                const gpu = GPUS[gpuId];
                const roomInfo = ROOMS[userDb.roomType || 'alagsor'];
                const currentGpuCount = userDb.rigs ? userDb.rigs.length : 0;

                if (currentGpuCount >= roomInfo.maxGpus) {
                    return i.reply({ content: `❌ A helyiséged megtelt (**${currentGpuCount}/${roomInfo.maxGpus}**)! Előbb bővítsd a szervertermedet.`, ephemeral: true });
                }

                if (userDb.balance < gpu.price) {
                    return i.reply({ content: `❌ Nincs elég pénzed erre a kártyára! (Ára: ${formatFt(gpu.price)})`, ephemeral: true });
                }

                userDb.balance -= gpu.price;
                if (!userDb.rigs) userDb.rigs = [];
                userDb.rigs.push({ gpuId: gpu.id, name: gpu.name, btcPerHour: gpu.btcPerHour });
                await userDb.save();

                return i.reply({ content: `🎉 Sikeresen megvásároltad a következőt: **${gpu.name}** (**${formatFt(gpu.price)}**)!`, ephemeral: true });
            }

            if (i.customId.startsWith('select_buy_room')) {
                const targetRoomKey = i.values[0];
                const targetRoom = ROOMS[targetRoomKey];

                if (userDb.balance < targetRoom.price) {
                    return i.reply({ content: `❌ Nincs elég pénzed erre a bővítésre! (Ára: ${formatFt(targetRoom.price)})`, ephemeral: true });
                }

                userDb.balance -= targetRoom.price;
                userDb.roomType = targetRoomKey;
                await userDb.save();

                return i.reply({ content: `🏢 Sikeresen megvásároltad a következőt: **${targetRoom.name}**! Új kapacitásod: **${targetRoom.maxGpus} db videokártya**.`, ephemeral: true });
            }

            if (i.customId.startsWith('select_buy_cooler')) {
                const targetCoolerKey = i.values[0];
                const targetCooler = COOLERS[targetCoolerKey];

                if (userDb.balance < targetCooler.price) {
                    return i.reply({ content: `❌ Nincs elég pénzed erre a hűtőrendszerre! (Ára: ${formatFt(targetCooler.price)})`, ephemeral: true });
                }

                userDb.balance -= targetCooler.price;
                userDb.coolerType = targetCoolerKey;
                await userDb.save();

                return i.reply({ content: `🌀 Sikeresen felszerelted a következőt: **${targetCooler.name}**! A szervertermed meghibásodási esélye jelentősen lecsökkent.`, ephemeral: true });
            }

            if (i.customId.startsWith('select_sell_gpu')) {
                const [gpuIndexStr, gpuId] = i.values[0].split('_');
                const gpuIndex = parseInt(gpuIndexStr);

                if (!userDb.rigs || !userDb.rigs[gpuIndex] || userDb.rigs[gpuIndex].gpuId !== gpuId) {
                    return i.reply({ content: '❌ Ez a kártya már nem található a szervertermedben!', ephemeral: true });
                }

                const originalGpu = GPUS[gpuId];
                const sellPrice = originalGpu ? Math.floor(originalGpu.price * 0.60) : 0;

                const soldGpuName = userDb.rigs[gpuIndex].name;
                userDb.rigs.splice(gpuIndex, 1);
                userDb.balance += sellPrice;
                await userDb.save();

                return i.update({
                    content: `✅ Sikeresen eladtad a következőt: **${soldGpuName}** az eredeti ár 60%-áért (**${formatFt(sellPrice)}**)! Jóváírva a számládon.`,
                    embeds: [],
                    components: []
                });
            }
        }
    } catch (err) {
        console.error('Hiba az interakció során:', err);
        if (!i.replied && !i.deferred) {
            await i.reply({ content: '❌ Hiba történt a parancs feldolgozása közben!', ephemeral: true }).catch(() => {});
        }
    }
});

client.login(process.env.TOKEN);
