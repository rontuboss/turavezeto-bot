require('dotenv').config();
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const ms = require('ms');

// --- TICKET ÉS EMLÉKEZTETŐ BEÁLLÍTÁSOK ---
const CONFIG = {
    DEFAULT_PARENT: '1527688497593585746', 
    SORSOLAS_PARENTS: ['1534568444974862506', '1534631388211445891'],
    PARTNER_PARENTS: ['1534568268956827758'],
    REMINDER_CHANNEL: '1546794386581356584',
    REMINDER_ROLE: '1546794488372924476'
};

// --- ADATBÁZIS CSATLAKOZÁS ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Adatbázis csatlakoztatva!'))
    .catch(err => console.error('❌ DB hiba:', err));

const Invite = mongoose.model('Invite', new mongoose.Schema({ guildId: String, userId: String, invites: Number }));
const Giveaway = mongoose.model('Giveaway', new mongoose.Schema({ messageId: String, channelId: String, guildId: String, endTime: Number, prize: String, winnerCount: Number, boosterBonus: Number, ended: { type: Boolean, default: false } }));

app.get('/', (req, res) => res.send('OK'));
app.listen(process.env.PORT || 3000);

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

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

const updateStatus = (g) => g && client.user.setPresence({ activities: [{ name: `👥 ${g.memberCount} tag | /giveaway`, type: 4 }], status: 'online' });

// AUTOMATA TICKET AUDIT ÉS SORREND DÍSZÍTÉS (1-50 -> Kat1, 51-100 -> Kat2)
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
        for (const [id] of userOverwrites) {
            await channel.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
        }
        setTimeout(() => auditAndFixCategories(guild, 'sima'), 1000);
        return { categoryName: 'Alapértelmezett Ticket' };
    }

    const parents = type === 'sorsolas' ? CONFIG.SORSOLAS_PARENTS : CONFIG.PARTNER_PARENTS;
    const catName = type === 'sorsolas' ? 'Nyereményjáték' : 'Partner';

    let targetCatId = parents[0];
    for (const pId of parents) {
        const cat = guild.channels.cache.get(pId);
        if (cat && guild.channels.cache.filter(c => c.parentId === cat.id).size < 50) {
            targetCatId = cat.id;
            break;
        }
    }

    await channel.setParent(targetCatId, { lockPermissions: false });
    for (const [id] of userOverwrites) {
        await channel.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
    }

    setTimeout(() => auditAndFixCategories(guild, type), 1000);
    return { categoryName: catName };
}

// NYEREMÉNYJÁTÉK LEZÁRÁSA RÉSZLETES LEÍRÁSSAL
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
            const endEmbed = EmbedBuilder.from(message.embeds[0]).setDescription('A nyereményjáték lezárult!').addFields({ name: 'Nyertes(ek)', value: embedVal });
            await message.edit({ embeds: [endEmbed] });

            const header = `🎉 **Gratulálok a nyerteseknek!** 🎉\n🎁 **Nyeremény:** ${gwData.prize}\n👑 **Nyertes(ek):**\n`;

            if ((header + mentions).length <= 2000) {
                await channel.send(`${header}${mentions}`);
            } else {
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

// AUTOMATA EMLÉKEZTETŐ IDŐZÍTŐ (15:58, 15:59, 16:00, 19:58, 19:59, 20:00)
let lastTriggeredMinute = '';
setInterval(async () => {
    const timeStr = new Date().toLocaleTimeString('hu-HU', { timeZone: 'Europe/Budapest', hour: '2-digit', minute: '2-digit', hour12: false });
    const targetTimes = ['15:58', '15:59', '16:00', '19:58', '19:59', '20:00'];
    
    if (targetTimes.includes(timeStr) && lastTriggeredMinute !== timeStr) {
        lastTriggeredMinute = timeStr;
        const channel = client.channels.cache.get(CONFIG.REMINDER_CHANNEL);
        if (channel) {
            const alertEmoji = channel.guild?.emojis.cache.find(e => e.name.toLowerCase() === 'alert') || '🚨';
            const eventTime = ['15:58', '15:59', '16:00'].includes(timeStr) ? '16:00' : '20:00';
            const count = Math.floor(Math.random() * 4) + 5; // 5-8 ping
            
            for (let i = 0; i < count; i++) {
                await channel.send({ content: `${alertEmoji} 🚨 **RIASZTÁS! MEGY A VÁNDORKERESKEDŐ! (${eventTime})** 🚨 ${alertEmoji}\n<@&${CONFIG.REMINDER_ROLE}>` }).catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }
}, 10000);

const commands = [
    new SlashCommandBuilder().setName('giveaway').setDescription('Nyereményjáték parancsok')
        .addSubcommand(s => s.setName('start').setDescription('Indítás').addStringOption(o => o.setName('duration').setDescription('Időtartam').setRequired(true)).addStringOption(o => o.setName('prize').setDescription('Nyeremény').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Nyertesek').setRequired(true).setMinValue(1)).addIntegerOption(o => o.setName('booster_bonus').setDescription('Booster bónusz %')))
        .addSubcommand(s => s.setName('reroll').setDescription('Újrasorsolás').addStringOption(o => o.setName('message_id').setDescription('Üzenet ID').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Új nyertesek')))
        .addSubcommand(s => s.setName('end').setDescription('Leállítás').addStringOption(o => o.setName('message_id').setDescription('Üzenet ID').setRequired(true))),
    new SlashCommandBuilder().setName('ticket').setDescription('Ticket parancsok')
        .addSubcommand(s => s.setName('setup').setDescription('Panel elküldése'))
        .addSubcommand(s => s.setName('sorsolas').setDescription('Nyereményjáték kategóriába'))
        .addSubcommand(s => s.setName('partner').setDescription('Partner kategóriába'))
        .addSubcommand(s => s.setName('sima').setDescription('Vissza az alapértelmezett kategóriába')),
    new SlashCommandBuilder().setName('invites').setDescription('Meghívók lekérése').addUserOption(o => o.setName('user').setDescription('Felhasználó')),
    
    // TROLL SLASH PARANCSOK
    new SlashCommandBuilder().setName('fakeban').setDescription('Troll kamu kitiltás').addUserOption(o => o.setName('user').setDescription('Kit tiltsunk ki kísérletképpen?').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Indok')),
    new SlashCommandBuilder().setName('nitro').setDescription('Ingyen Discord Nitro ajándék (kamu)'),
    new SlashCommandBuilder().setName('mock').setDescription('Spongyabob gúnyolódó szöveg').addStringOption(o => o.setName('text').setDescription('A gúnyolandó szöveg').setRequired(true))
].map(c => c.toJSON());

client.once('ready', async () => {
    console.log(`Sikeresen elindult: ${client.user.tag}`);
    await new REST({ version: '10' }).setToken(process.env.TOKEN).put(Routes.applicationCommands(client.user.id), { body: commands });
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

// PREFIX PARANCSOK (.sorsolas, .partner, .sima) ÉS VÉLETLENSZERŰ REAKCIÓK
client.on('messageCreate', async (m) => {
    if (m.author.bot || !m.guild) return;
    const cmd = m.content.toLowerCase().trim();

    // 1.5% esély véletlenszerű troll reakcióra (🤡 vagy 🤓)
    if (Math.random() < 0.015) {
        const randEmoji = Math.random() < 0.5 ? '🤡' : '🤓';
        m.react(randEmoji).catch(() => {});
    }

    if (['.sorsolas', '.partner', '.sima'].includes(cmd)) {
        await m.delete().catch(() => {});
        if (!m.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            const r = await m.channel.send('❌ Nincs jogosultságod!');
            return setTimeout(() => r.delete().catch(() => {}), 3000);
        }

        const type = cmd === '.sorsolas' ? 'sorsolas' : (cmd === '.partner' ? 'partner' : 'sima');
        try {
            const res = await moveTicketCategory(m.channel, m.guild, type);
            const r = await m.channel.send(`✅ Ticket áthelyezve ide: **${res.categoryName}**!`);
            setTimeout(() => r.delete().catch(() => {}), 4000);
        } catch (err) {
            const r = await m.channel.send(`❌ Hiba: ${err.message || 'Ellenőrizd a bot jogait!'}`);
            setTimeout(() => r.delete().catch(() => {}), 5000);
        }
    }
});

// INTERAKCIÓK (SLASH COMMANDS & BUTTONS)
client.on('interactionCreate', async (i) => {
    if (!i.isCommand() && !i.isButton()) return;

    if (i.isChatInputCommand()) {
        // TROLL PARANCSOK
        if (i.commandName === 'fakeban') {
            const user = i.options.getUser('user');
            const reason = i.options.getString('reason') || 'Nincs megadva';
            const banEmbed = new EmbedBuilder().setColor('#ff0000').setTitle('🔨 Tag Kitiltva!').setDescription(`**Felhasználó:** <@${user.id}>\n**Indok:** ${reason}\n**Moderátor:** <@${i.user.id}>`);
            await i.reply({ embeds: [banEmbed] });
            setTimeout(async () => {
                const jokeEmbed = new EmbedBuilder().setColor('#ffaa00').setTitle('🤡 CSAK VICCELTEM!').setDescription(`**<@${user.id}>** nem lett kitiltva, maradhatsz! 🎉`);
                await i.editReply({ embeds: [jokeEmbed] }).catch(() => {});
            }, 3000);
            return;
        }

        if (i.commandName === 'nitro') {
            const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎁 Discord Nitro Gift!').setDescription('Nyertél 1 hónap Discord Nitro-t! Kattints az alábbi gombra az átvételhez!').setThumbnail('https://i.imgur.com/264293f.png');
            const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('claim_fake_nitro').setLabel('🎁 Claim Nitro').setStyle(ButtonStyle.Success));
            return i.reply({ embeds: [embed], components: [btn] });
        }

        if (i.commandName === 'mock') {
            const text = i.options.getString('text');
            const mocked = text.split('').map((char, idx) => idx % 2 === 0 ? char.toLowerCase() : char.toUpperCase()).join('');
            return i.reply({ content: `${mocked} 🤡` });
        }

        // INVITES
        if (i.commandName === 'invites') {
            const user = i.options.getUser('user') || i.user;
            const data = await Invite.findOne({ guildId: i.guild.id, userId: user.id });
            return i.reply({ content: `📩 **${user.username}** eddig **${data ? data.invites : 0}** embert hívott meg!`, ephemeral: false });
        }

        // TICKET PARANCSOK
        if (i.commandName === 'ticket') {
            const sub = i.options.getSubcommand();
            if (sub === 'setup') {
                if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '❌ Nincs jogod!', ephemeral: true });
                const embed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎫 Ticket Nyitása').setDescription('Kattints az alábbi gombra privát csatorna nyitásához!');
                const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('📩 Ticket Nyitása').setStyle(ButtonStyle.Primary));
                await i.channel.send({ embeds: [embed], components: [btn] });
                return i.reply({ content: '✅ Panel elkészült!', ephemeral: true });
            }

            if (['sorsolas', 'partner', 'sima'].includes(sub)) {
                if (!i.member.permissions.has(PermissionFlagsBits.ManageChannels)) return i.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });
                try {
                    const res = await moveTicketCategory(i.channel, i.guild, sub);
                    return i.reply({ content: `✅ Ticket áthelyezve ide: **${res.categoryName}**!`, ephemeral: true });
                } catch (err) {
                    return i.reply({ content: `❌ Hiba történt!`, ephemeral: true });
                }
            }
        }

        // GIVEAWAY
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
            }

            if (sub === 'reroll') {
                const msgId = i.options.getString('message_id');
                const count = i.options.getInteger('winners') || 1;
                await i.deferReply({ ephemeral: true });
                const gwData = await Giveaway.findOne({ messageId: msgId });
                if (!gwData) return i.editReply({ content: '❌ Nyereményjáték nem található!' });

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
            }

            if (sub === 'end') {
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
        // TROLL NITRO GOMB KLIKK
        if (i.customId === 'claim_fake_nitro') {
            return i.reply({ content: `🎉 **<@${i.user.id}>** bedőlt a kamu Nitrónak és át lett verve! 🤡`, ephemeral: false });
        }

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
            await i.reply({ content: `✅ Ticket nyitva: <#${ch.id}>`, ephemeral: true });
        }

        if (i.customId === 'close_ticket') {
            if (!i.member.permissions.has(PermissionFlagsBits.ManageChannels)) return i.reply({ content: '❌ Nincs jogod!', ephemeral: true });
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
