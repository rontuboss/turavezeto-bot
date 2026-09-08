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
    FIXED_USER_ID: '1546986417631002676'
};

const BASE_BTC_PRICE = 35000000; // Alap BTC ár (35,000,000 Ft)

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
    rigs: [{ gpuId: String, name: String, btcPerHour: Number }],
    isBroken: { type: Boolean, default: false },
    repairUntil: { type: Number, default: 0 },
    lastBtcClaim: { type: Number, default: Date.now },
    lastTreasure: { type: Number, default: 0 },
    lastDaily: { type: Number, default: 0 },
    lastWeekly: { type: Number, default: 0 },
    lastWork: { type: Number, default: 0 },
    stats: {
        blackjack: { played: { type: Number, default: 0 }, won: { type: Number, default: 0 }, netProfit: { type: Number, default: 0 } },
        mines: { played: { type: Number, default: 0 }, won: { type: Number, default: 0 }, netProfit: { type: Number, default: 0 } }
    }
}));

const GuildSetting = mongoose.model('GuildSetting', new mongoose.Schema({
    guildId: String,
    casinoLossVault: { type: Number, default: 0 },
    btcPriceFt: { type: Number, default: BASE_BTC_PRICE }
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
// 3. HARDVER ÉS SZOBA ADATOK
// ==========================================
const ROOMS = {
    alagsor: { name: '📦 Alagsori Doboz', price: 500000, maxGpus: 4 },
    garazs: { name: '🏠 Garázs Rig', price: 5000000, maxGpus: 12 },
    szerver: { name: '🏢 Hivatalos Szerverterem', price: 35000000, maxGpus: 25 },
    adatkozpont: { name: '⚡ Ipari Adatközpont', price: 150000000, maxGpus: 50 }
};

const GPUS = {
    gt1030: { id: 'gt1030', name: 'NVIDIA GT 1030', rarity: 'common', price: 50000, btcPerHour: 0.000004 },
    rx550: { id: 'rx550', name: 'AMD Radeon RX 550', rarity: 'common', price: 75000, btcPerHour: 0.000006 },
    gtx1060: { id: 'gtx1060', name: 'NVIDIA GTX 1060 6GB', rarity: 'rare', price: 300000, btcPerHour: 0.000028 },
    rx580: { id: 'rx580', name: 'AMD Radeon RX 580', rarity: 'rare', price: 450000, btcPerHour: 0.000043 },
    rtx3060ti: { id: 'rtx3060ti', name: 'NVIDIA RTX 3060 Ti', rarity: 'epic', price: 1500000, btcPerHour: 0.000170 },
    rtx3080: { id: 'rtx3080', name: 'NVIDIA RTX 3080', rarity: 'epic', price: 3500000, btcPerHour: 0.000420 },
    rtx4090: { id: 'rtx4090', name: 'NVIDIA RTX 4090', rarity: 'legendary', price: 10000000, btcPerHour: 0.001400 },
    rx7900xtx: { id: 'rx7900xtx', name: 'AMD Radeon RX 7900 XTX', rarity: 'legendary', price: 12500000, btcPerHour: 0.001800 },
    h100: { id: 'h100', name: 'NVIDIA H100 AI Accelerator', rarity: 'mythic', price: 45000000, btcPerHour: 0.007500 },
    quantum: { id: 'quantum', name: 'Quantum Miner Rig X-1', rarity: 'mythic', price: 100000000, btcPerHour: 0.018000 }
};

// ==========================================
// 4. HELPER & TIME FUNCTIONS
// ==========================================
const formatFt = (amount) => new Intl.NumberFormat('hu-HU').format(amount) + ' Ft';
const formatBtc = (amount) => amount.toFixed(8) + ' BTC';
const formatBtcWithFt = (btcAmount, priceFt) => `${formatBtc(btcAmount)} (~${formatFt(Math.floor(btcAmount * priceFt))})`;

const getBudapestDate = () => {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Budapest" }));
};

const getBudapestMidnightMs = () => {
    const bpNow = getBudapestDate();
    return new Date(bpNow.getFullYear(), bpNow.getMonth(), bpNow.getDate()).getTime();
};

const getUserDb = async (guildId, userId) => {
    let user = await User.findOne({ guildId, userId });
    if (!user) {
        const initialBalance = (userId === CONFIG.FIXED_USER_ID) ? 10000000 : 0;
        user = new User({ guildId, userId, balance: initialBalance, loanDebt: 0 });
        await user.save();
    } else if (userId === CONFIG.FIXED_USER_ID && user.balance !== 10000000) {
        user.balance = 10000000;
        await user.save();
    }
    return user;
};

async function getGuildSettings(guildId) {
    let settings = await GuildSetting.findOne({ guildId });
    if (!settings) {
        settings = new GuildSetting({ guildId, casinoLossVault: 0, btcPriceFt: BASE_BTC_PRICE });
        await settings.save();
    }
    return settings;
}

async function addLossToVault(guildId, amount) {
    if (amount <= 0) return;
    try {
        const settings = await getGuildSettings(guildId);
        settings.casinoLossVault += amount;
        await settings.save();
    } catch (e) {
        console.error('❌ Hiba a globális kaszinó számla frissítésekor:', e);
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
// 6. MINIGAME LOGIC (MINES 5x5 & BLACKJACK)
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
// 7. GIVEAWAY, REMINDERS & TIMERS
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

// 5% kamat 3 percenként a meglévő egyenlegre
setInterval(async () => {
    try {
        const users = await User.find({ balance: { $gt: 0 } });
        for (const u of users) {
            const interest = Math.floor(u.balance * 0.05);
            if (interest > 0) {
                u.balance += interest;
                await u.save();
            }
        }
    } catch (e) {
        console.error('❌ Hiba a kamatszámításkor:', e);
    }
}, 3 * 60 * 1000);

// Óránkénti Bitcoin árfolyam ingadozás (-50% és +50% korlátok között az alapárhoz képest) & 1% áramszünet esély
setInterval(async () => {
    try {
        const settings = await GuildSetting.findOne({});
        if (settings) {
            const changePercent = (Math.random() * 0.08 - 0.04); // ±4% elmozdulás óránként
            let newPrice = Math.floor(settings.btcPriceFt * (1 + changePercent));
            
            // Korlátozás: MIN = -50% (17.5M Ft), MAX = +50% (52.5M Ft)
            const minPrice = BASE_BTC_PRICE * 0.50;
            const maxPrice = BASE_BTC_PRICE * 1.50;

            if (newPrice < minPrice) newPrice = minPrice;
            if (newPrice > maxPrice) newPrice = maxPrice;

            settings.btcPriceFt = newPrice;
            await settings.save();
        }

        const users = await User.find({ "rigs.0": { $exists: true }, isBroken: false });
        for (const u of users) {
            if (Math.random() < 0.01) {
                u.isBroken = true;
                await u.save();
                
                const ch = client.channels.cache.get(CONFIG.MINER_CHANNEL);
                if (ch) {
                    ch.send(`⚡ 🚨 **ÁRAMSZÜNET / MEGHIBÁSODÁS!** <@${u.userId}> szerverterme leállt! Használd a \`/crypto szerviz\` parancsot a javításhoz!`).catch(() => {});
                }
            }
        }
    } catch (e) {
        console.error('❌ Hiba a bányász időzítőben:', e);
    }
}, 60 * 60 * 1000);

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
    new SlashCommandBuilder().setName('removeloan').setDescription('Hitel törlése egy felhasználóról (Admin)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false)
        .addUserOption(o => o.setName('user').setDescription('Kinek a hitelét töröljük?').setRequired(true))
        .addIntegerOption(o => o.setName('osszeg').setDescription('Törlendő összeg (Ha üres, a teljes hitelt törli)')),
    new SlashCommandBuilder().setName('fakeban').setDescription('Troll kamu kitiltás').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Felhasználó').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Indok')),
    new SlashCommandBuilder().setName('nitro').setDescription('Ingyen Discord Nitro ajándék (kamu)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false),
    new SlashCommandBuilder().setName('mock').setDescription('Spongyabob gúnyolódó szöveg').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addStringOption(o => o.setName('text').setDescription('A szöveg').setRequired(true)),
    new SlashCommandBuilder().setName('roulette').setDescription('Orosz rulett játék (1/6 esély 1 perces némításra)').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false),
    new SlashCommandBuilder().setName('roast').setDescription('Vicces beszólogatás').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Kinek szóljon?').setRequired(true)),
    new SlashCommandBuilder().setName('rate').setDescription('Értékelj bármit').setDefaultMemberPermissions(ADMIN_PERM).setDMPermission(false).addStringOption(o => o.setName('thing').setDescription('Mit értékeljen?').setRequired(true)),

    // ÚJ / FRISSÍTETT CRYPTO & BTC PARANCSOK
    new SlashCommandBuilder().setName('btc').setDescription('Bitcoin árfolyam és eladás')
        .addSubcommand(s => s.setName('sell').setDescription('Bitcoin eladása készpénzért (Ft)').addNumberOption(o => o.setName('btc').setDescription('Eladandó BTC').setRequired(true))),
    new SlashCommandBuilder().setName('crypto').setDescription('Bányász és szerverterem kezelés')
        .addSubcommand(s => s.setName('bolt').setDescription('Bányász bolt megnyitása (Kártyák és Szobák)'))
        .addSubcommand(s => s.setName('farm').setDescription('Saját szerverterem és rigek állapota'))
        .addSubcommand(s => s.setName('claim').setDescription('Kitermelt Bitcoin begyűjtése'))
        .addSubcommand(s => s.setName('kartya-eladas').setDescription('Birtokolt videokártya eladása (60%-os áron)'))
        .addSubcommand(s => s.setName('szerviz').setDescription('Szerverterem javítása (100k Ft / 1 óra)')),

    new SlashCommandBuilder().setName('invites').setDescription('Meghívók lekérése').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('treasure').setDescription('Ingyen Forint kikérése (Boostereknek 7 perc, másnak 10 perc)'),
    new SlashCommandBuilder().setName('daily').setDescription('Napi ingyen jutalom (1.000.000 Ft, budapesti éjféli reset)'),
    new SlashCommandBuilder().setName('weekly').setDescription('Heti ingyen jutalom (10.000.000 Ft, 7 naponta)'),
    new SlashCommandBuilder().setName('work').setDescription('Munkavégzés pénzért (1 perc cooldown)'),
    new SlashCommandBuilder().setName('bal').setDescription('Egyenleg lekérése').addUserOption(o => o.setName('user').setDescription('Kinek az egyenlege?')),
    new SlashCommandBuilder().setName('stat').setDescription('Kaszinó statisztika lekérése').addUserOption(o => o.setName('user').setDescription('Kinek a statisztikája?')),
    new SlashCommandBuilder().setName('hitel').setDescription('Banki hitel parancsok (10% kamat)')
        .addSubcommand(s => s.setName('felvesz').setDescription('Hitel felvétele (max 50 millió Ft)').addIntegerOption(o => o.setName('osszeg').setDescription('Igényelt összeg (Ft)').setRequired(true).setMinValue(1).setMaxValue(50000000)))
        .addSubcommand(s => s.setName('statusz').setDescription('Aktuális hitel lekérése'))
        .addSubcommand(s => s.setName('torleszt').setDescription('Hitel visszafizetése').addIntegerOption(o => o.setName('osszeg').setDescription('Visszafizetendő összeg (Ft)').setRequired(true).setMinValue(1))),
    new SlashCommandBuilder().setName('top').setDescription('A szerver leggazdagabb tagjai'),
    new SlashCommandBuilder().setName('mines').setDescription('Aknakereső kaszinó minijáték').addIntegerOption(o => o.setName('bet').setDescription('Tét összege (Ft)').setRequired(true).setMinValue(100)).addIntegerOption(o => o.setName('bombs').setDescription('Bombák száma (1-24)').setRequired(true).setMinValue(1).setMaxValue(24)),
    new SlashCommandBuilder().setName('blackjack').setDescription('Klasszikus 21-es blackjack kártyajáték').addIntegerOption(o => o.setName('bet').setDescription('Tét összege (Ft)').setRequired(true).setMinValue(100)),
    new SlashCommandBuilder().setName('iq').setDescription('IQ teszt mérés').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    new SlashCommandBuilder().setName('meret').setDescription('Faszméret mérés').addUserOption(o => o.setName('user').setDescription('Kinek a mérete?'))
].map(c => c.toJSON());

// ==========================================
// 9. BOT READY & EVENT LISTENERS
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
// 10. INTERACTIONS & REACTION HANDLERS
// ==========================================
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot || !reaction.message.guild) return;
    if (reaction.emoji.name !== '✅') return;

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
    if (!i.isCommand() && !i.isButton() && !i.isStringSelectMenu()) return;

    if (i.isChatInputCommand()) {
        const isStaff = i.member?.roles?.cache?.has(CONFIG.STAFF_ROLE);
        const isMember = i.member?.roles?.cache?.has(CONFIG.MEMBER_ROLE) || isStaff;
        const allowedForMembers = ['mines', 'blackjack', 'iq', 'meret', 'treasure', 'daily', 'weekly', 'work', 'bal', 'stat', 'top', 'invites', 'hitel', 'btc', 'crypto'];

        if (!isMember) return i.reply({ content: '❌ Nincs meg a szükséges rangod a parancsok használatához!', ephemeral: true });
        if (!allowedForMembers.includes(i.commandName) && !isStaff) return i.reply({ content: '❌ Ez a parancs kizárólag a kijelölt rangosoknak érhető el!', ephemeral: true });

        const userDb = await getUserDb(i.guild.id, i.user.id);
        const settings = await getGuildSettings(i.guild.id);

        if (!userDb.stats) {
            userDb.stats = { blackjack: { played: 0, won: 0, netProfit: 0 }, mines: { played: 0, won: 0, netProfit: 0 } };
        }

        // ==========================================
        // 📈 /BTC PARANCSOK (PIAC ÉS ELADÁS)
        // ==========================================
        if (i.commandName === 'btc') {
            const sub = i.options.getSubcommand(false);

            // Sima /btc -> Árfolyam lekérés
            if (!sub) {
                const diffPercent = (((settings.btcPriceFt - BASE_BTC_PRICE) / BASE_BTC_PRICE) * 100).toFixed(1);
                const diffTag = diffPercent >= 0 ? `+${diffPercent}%` : `${diffPercent}%`;
                
                const embed = new EmbedBuilder()
                    .setColor('#f7931a')
                    .setTitle('📈 BITCOIN PIACI ÁRFOLYAM')
                    .addFields(
                        { name: '🪙 Jelenlegi Árfolyam', value: `**1 BTC = ${formatFt(settings.btcPriceFt)}**`, inline: false },
                        { name: '📊 Piaci Változás (Alapárhoz képest)', value: `\`\`\`diff\n${diffTag}\`\`\``, inline: false }
                    );

                return i.reply({ embeds: [embed] });
            }

            // /btc sell -> Bitcoin eladás készpénzre
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

        // ==========================================
        // ⚡ /CRYPTO PARANCSOK (FARM, BOLT, CLAIM, SZERVIZ)
        // ==========================================
        if (i.commandName === 'crypto') {
            const sub = i.options.getSubcommand();

            if (sub === 'bolt') {
                const embed = new EmbedBuilder()
                    .setColor('#f7931a')
                    .setTitle('🛒 KRIPTOBÁNYÁSZ BOLT')
                    .setDescription('Válassz az alábbi lehetőségek közül gombok segítségével!')
                    .addFields(
                        { name: '🖥️ Videokártyák', value: 'Vásárolj bányászkártyákat a kapacitásod erejéig!', inline: true },
                        { name: '🏢 Szerverterem', value: 'Bővítsd a helyiségedet több férőhelyért!', inline: true }
                    );

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_menu_gpus_${i.user.id}`).setLabel('🖥️ Videokártyák').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`miner_menu_rooms_${i.user.id}`).setLabel('🏢 Szerverterem Bővítés').setStyle(ButtonStyle.Success)
                );

                return i.reply({ embeds: [embed], components: [row], ephemeral: true });
            }

            if (sub === 'farm') {
                const roomInfo = ROOMS[userDb.roomType || 'alagsor'];
                const gpuCount = userDb.rigs ? userDb.rigs.length : 0;
                const now = Date.now();
                const hoursPassed = (now - (userDb.lastBtcClaim || now)) / (1000 * 60 * 60);
                
                let btcPerHourTotal = 0;
                if (userDb.rigs && !userDb.isBroken) {
                    btcPerHourTotal = userDb.rigs.reduce((sum, r) => sum + r.btcPerHour, 0);
                }
                const minedBtc = hoursPassed * btcPerHourTotal;

                let statusText = '🟢 **Működik**';
                if (userDb.isBroken) {
                    if (userDb.repairUntil > now) {
                        const remMin = Math.ceil((userDb.repairUntil - now) / (1000 * 60));
                        statusText = `🛠️ **Szerelés alatt (${remMin} perc van hátra)**`;
                    } else if (userDb.repairUntil > 0 && userDb.repairUntil <= now) {
                        userDb.isBroken = false;
                        userDb.repairUntil = 0;
                        await userDb.save();
                    } else {
                        statusText = '⚡ **ÁRAMSZÜNET / MEGHIBÁSODÁS (Szerviz szükséges!)**';
                    }
                }

                const embed = new EmbedBuilder()
                    .setColor('#00f2fe')
                    .setTitle(`⚡ ${i.user.username} Bányász Farmja`)
                    .addFields(
                        { name: '🏢 Helyiség', value: `${roomInfo.name} (${gpuCount}/${roomInfo.maxGpus} kártya)`, inline: true },
                        { name: '📊 Státusz', value: statusText, inline: true },
                        { name: '📈 Termelés', value: `**${formatBtcWithFt(btcPerHourTotal, settings.btcPriceFt)}** / óra`, inline: false },
                        { name: '🪙 Begyűjthető Bitcoin', value: `**${formatBtcWithFt(minedBtc, settings.btcPriceFt)}**`, inline: false },
                        { name: '💳 Egyenlegeid', value: `• Wallet: **${formatBtcWithFt(userDb.btcBalance || 0, settings.btcPriceFt)}**\n• Cash: **${formatFt(userDb.balance)}**`, inline: false }
                    );

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`miner_claim_btn_${i.user.id}`).setLabel('💰 BTC Begyűjtése').setStyle(ButtonStyle.Success).setDisabled(minedBtc <= 0 || userDb.isBroken)
                );

                return i.reply({ embeds: [embed], components: [row] });
            }

            if (sub === 'claim') {
                if (userDb.isBroken) return i.reply({ content: '❌ A szervertermed jelenleg le van állva! Szervizelés szükséges.', ephemeral: true });

                const now = Date.now();
                const hoursPassed = (now - (userDb.lastBtcClaim || now)) / (1000 * 60 * 60);
                let btcPerHourTotal = userDb.rigs ? userDb.rigs.reduce((sum, r) => sum + r.btcPerHour, 0) : 0;
                const minedBtc = hoursPassed * btcPerHourTotal;

                if (minedBtc <= 0) return i.reply({ content: '❌ Még nincs begyűjthető Bitcoinod!', ephemeral: true });

                userDb.btcBalance = (userDb.btcBalance || 0) + minedBtc;
                userDb.lastBtcClaim = now;
                await userDb.save();

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
                userDb.repairUntil = Date.now() + (60 * 60 * 1000);
                await userDb.save();

                return i.reply({ content: '🔧 **Szerviz elindítva!** A szerverterem **1 óra múlva** újra működni fog!', ephemeral: true });
            }
        }

        if (i.commandName === 'removeloan') {
            if (!isStaff) return i.reply({ content: '❌ Nincs jogosultságod ehhez a parancshoz!', ephemeral: true });
            
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

            const baseMin = 3750;
            const baseMax = 12500;
            const randomBase = Math.floor(Math.random() * (baseMax - baseMin + 1)) + baseMin;
            const balanceBonus = Math.floor(Math.max(0, userDb.balance) * 0.005);
            const workAmount = randomBase + balanceBonus;

            userDb.balance += workAmount;
            userDb.lastWork = now;
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
            const baseMin = 25000;
            const baseMax = 60000;
            const randomBase = Math.floor(Math.random() * (baseMax - baseMin + 1)) + baseMin;
            const balanceBonus = Math.floor(Math.max(0, userDb.balance) * 0.01);
            const amount = isSuperChest ? 312500 + Math.floor(Math.max(0, userDb.balance) * 0.05) : randomBase + balanceBonus;

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
                if (amount > 50000000) {
                    return i.reply({ content: `❌ Legfeljebb 50 000 000 Ft hitelt vehetsz fel!`, ephemeral: true });
                }

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
                await userDb.save();

                return i.reply({ content: `✅ Sikeresen törlesztettél **${formatFt(payAmount)}**-ot a hiteledből!\n• Hátralévő tartozás: **${formatFt(userDb.loanDebt)}**\n• Új egyenleg: **${formatFt(userDb.balance)}**` });
            }
        }

        if (i.commandName === 'top') {
            const topUsers = await User.find({ guildId: i.guild.id }).sort({ balance: -1 }).limit(10);
            const totalLoss = settings.casinoLossVault;

            let desc = `🔴 **Globális kaszinó veszteség:** \`\`\`diff\n-${formatFt(totalLoss)}\`\`\`\n`;
            desc += `👑 **A leggazdagabb tagok:**\n`;
            
            topUsers.forEach((u, index) => {
                desc += `**${index + 1}.** <@${u.userId}> — **${formatFt(u.balance)}**\n`;
            });

            const embed = new EmbedBuilder()
                .setColor('#ffd700')
                .setTitle('🏆 A Szerver Leggazdagabb Tagjai & Kaszinó Stat')
                .setDescription(desc || 'Még senkinek sincs pénze.');
            
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
                await i.reply({ content: '⏳ Feldolgozás...', ephemeral: true });
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
                await i.reply({ content: '⏳ Feldolgozás...', ephemeral: true });
                const gwData = await Giveaway.findOne({ messageId: msgId });
                if (!gwData) return i.editReply({ content: '❌ Nem található!' });
                gwData.ended = false;
                await endGiveaway(gwData);
                return i.editReply({ content: '✅ Lezárva és kisorsolva!' });
            }
        }
    }

    // ==========================================
    // GOMB- ÉS MENÜINTERAKCIÓK
    // ==========================================
    if (i.isButton()) {
        const userDb = await getUserDb(i.guild.id, i.user.id);
        const settings = await getGuildSettings(i.guild.id);

        if (i.customId.startsWith('miner_')) {
            const parts = i.customId.split('_');
            const ownerId = parts[parts.length - 1];

            if (ownerId && ownerId !== i.user.id && !['claim_btn'].some(k => i.customId.includes(k))) {
                return i.reply({ content: '❌ Ez nem a te bányász bolton! Nyiss egy sajátot a `/crypto bolt` parancssal! 🤡', ephemeral: true });
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
                .setDescription('Vásárolj nagyobb helyiséget, hogy több videokártyát tudj elhelyezni!')
                .addFields(
                    { name: '📦 Alagsori Doboz', value: 'Ár: **500 000 Ft** | Férőhely: **4 db**', inline: false },
                    { name: '🏠 Garázs Rig', value: 'Ár: **5 000 000 Ft** | Férőhely: **12 db**', inline: false },
                    { name: '🏢 Hivatalos Szerverterem', value: 'Ár: **35 000 000 Ft** | Férőhely: **25 db**', inline: false },
                    { name: '⚡ Ipari Adatközpont', value: 'Ár: **150 000 000 Ft** | Férőhely: **50 db**', inline: false }
                );

            const select = new StringSelectMenuBuilder()
                .setCustomId(`select_buy_room_${i.user.id}`)
                .setPlaceholder('Válassz szobát a megvásárláshoz...')
                .addOptions([
                    { label: 'Alagsori Doboz (500 000 Ft)', value: 'alagsor' },
                    { label: 'Garázs Rig (5 000 000 Ft)', value: 'garazs' },
                    { label: 'Hivatalos Szerverterem (35 000 000 Ft)', value: 'szerver' },
                    { label: 'Ipari Adatközpont (150 000 000 Ft)', value: 'adatkozpont' }
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
                    { name: '🏢 Szerverterem', value: 'Bővítsd a helyiségedet több férőhelyért!', inline: true }
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`miner_menu_gpus_${i.user.id}`).setLabel('🖥️ Videokártyák').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`miner_menu_rooms_${i.user.id}`).setLabel('🏢 Szerverterem Bővítés').setStyle(ButtonStyle.Success)
            );

            return i.update({ embeds: [embed], components: [row] });
        }

        if (i.customId.startsWith('miner_claim_btn')) {
            const now = Date.now();
            const hoursPassed = (now - (userDb.lastBtcClaim || now)) / (1000 * 60 * 60);
            let btcPerHourTotal = userDb.rigs ? userDb.rigs.reduce((sum, r) => sum + r.btcPerHour, 0) : 0;
            const minedBtc = hoursPassed * btcPerHourTotal;

            if (minedBtc <= 0) return i.reply({ content: '❌ Nincs begyűjthető Bitcoin!', ephemeral: true });

            userDb.btcBalance = (userDb.btcBalance || 0) + minedBtc;
            userDb.lastBtcClaim = now;
            await userDb.save();

            return i.reply({ content: `🎉 Sikeresen begyűjtöttél **${formatBtcWithFt(minedBtc, settings.btcPriceFt)}**-t!`, ephemeral: true });
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

    if (i.isStringSelectMenu()) {
        const userDb = await getUserDb(i.guild.id, i.user.id);
        const settings = await getGuildSettings(i.guild.id);

        if (i.customId.startsWith('select_')) {
            const parts = i.customId.split('_');
            const ownerId = parts[parts.length - 1];

            if (ownerId && ownerId !== i.user.id) {
                return i.reply({ content: '❌ Ez nem a te bányász bolton! Nyiss egy sajátot a `/crypto bolt` parancssal! 🤡', ephemeral: true });
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
                new ButtonBuilder().setCustomId(`miner_menu_gpus_${i.user.id}`).setLabel('◀️ Vissza a kategóriákhoz').setStyle(ButtonStyle.Secondary)
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

        if (i.customId.startsWith('select_sell_gpu')) {
            const [gpuIndexStr, gpuId] = i.values[0].split('_');
            const gpuIndex = parseInt(gpuIndexStr);

            if (!userDb.rigs[gpuIndex] || userDb.rigs[gpuIndex].gpuId !== gpuId) {
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
});

client.login(process.env.TOKEN);
