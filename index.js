require('dotenv').config();
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const { 
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
    EmbedBuilder, Partials, ActionRowBuilder, ButtonBuilder, 
    ButtonStyle, ChannelType, PermissionFlagsBits, AttachmentBuilder 
} = require('discord.js');
const ms = require('ms');

// --- TICKET KATEGÓRIA BEÁLLÍTÁSOK ---
// Itt adhatod meg a Nyereményjáték kategóriák ID-jait sorban!
const TICKET_CONFIG = {
    DEFAULT_PARENT: '1527688497593585746', 
    SORSOLAS_PARENTS: [
        '1534568444974862506', // 1. Nyereményjáték kategória ID
        '1534631388211445891' // 2. Nyereményjáték kategória ID (cseréld ki!)
    ],
    PARTNER_PARENTS: ['1534568268956827758']
};

// --- ADATBÁZIS CSATLAKOZÁS ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Adatbázis sikeresen csatlakoztatva!'))
    .catch(err => console.error('❌ Adatbázis hiba:', err));

const inviteSchema = new mongoose.Schema({ guildId: String, userId: String, invites: Number });
const Invite = mongoose.model('Invite', inviteSchema);

const giveawaySchema = new mongoose.Schema({
    messageId: String,
    channelId: String,
    guildId: String,
    endTime: Number,
    prize: String,
    winnerCount: Number,
    boosterBonus: Number,
    ended: { type: Boolean, default: false }
});
const Giveaway = mongoose.model('Giveaway', giveawaySchema);

// --- WEB SZERVER A RENDERNEK ---
app.get('/', (req, res) => res.send('A bot tökéletesen fut és online!'));
app.listen(process.env.PORT || 3000, () => console.log('A webes kiszolgáló elindult.'));

// --- DISCORD KLIENS ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions, 
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- SEGÉDFÜGGVÉNYEK ---
function drawWinners(participants, count) {
    const winners = [];
    let currentParticipants = [...participants];
    for (let i = 0; i < count; i++) {
        if (currentParticipants.length === 0) break;
        const totalWeight = currentParticipants.reduce((sum, p) => sum + p.weight, 0);
        let random = Math.random() * totalWeight;
        for (let j = 0; j < currentParticipants.length; j++) {
            random -= currentParticipants[j].weight;
            if (random <= 0) { winners.push(currentParticipants[j].id); currentParticipants.splice(j, 1); break; }
        }
    }
    return winners;
}

function updateStatus(guild) {
    if (guild) client.user.setPresence({ activities: [{ name: `👥 ${guild.memberCount} tag | /giveaway`, type: 4 }], status: 'online' });
}

// TICKET KATEGÓRIA ÁTMOZGATÓ ÉS ÁTNEVEZŐ AUTOMATIKUS OKOS KAPACITÁS-KEREŐ FÜGGVÉNY
async function moveTicketCategory(channel, guild, categoryType) {
    const targetCategoryIds = categoryType === 'sorsolas' 
        ? TICKET_CONFIG.SORSOLAS_PARENTS 
        : TICKET_CONFIG.PARTNER_PARENTS;

    const categoryName = categoryType === 'sorsolas' ? 'Nyereményjáték' : 'Partner';
    const nameSuffix = categoryType === 'sorsolas' ? 'nyeremeny' : 'partner';

    // 1. Megkeressük a listából az első olyan kategóriát, amiben még van szabad hely (kevesebb mint 50 szoba)
    let selectedCategory = null;
    for (const catId of targetCategoryIds) {
        if (!catId || catId.includes('IDE_ÍRD')) continue;
        const cat = guild.channels.cache.get(catId);
        if (cat) {
            const count = guild.channels.cache.filter(c => c.parentId === cat.id).size;
            if (count < 50) {
                selectedCategory = cat;
                break;
            }
        }
    }

    // 2. Ha a megadott kategóriák mind beteltek, a bot automatikusan nyit egy újat a Discordon!
    if (!selectedCategory) {
        const firstValidCatId = targetCategoryIds.find(id => id && !id.includes('IDE_ÍRD'));
        const baseCat = firstValidCatId ? guild.channels.cache.get(firstValidCatId) : null;
        
        const overflowCount = targetCategoryIds.length + 1;
        selectedCategory = await guild.channels.create({
            name: `🎁 ${categoryName} (${overflowCount})`,
            type: ChannelType.GuildCategory,
            permissionOverwrites: baseCat ? baseCat.permissionOverwrites.cache.map(p => ({
                id: p.id,
                allow: p.allow,
                deny: p.deny
            })) : []
        });
        targetCategoryIds.push(selectedCategory.id);
    }

    // 3. Globális sorszámozás az EGÉSZ szerver nyereményjátékos csatornái alapján
    const allMatchingChannels = guild.channels.cache.filter(c => c.name.includes(`-${nameSuffix}-`));
    let maxNum = 0;
    allMatchingChannels.forEach(c => {
        const parts = c.name.split('-');
        const num = parseInt(parts[parts.length - 1]);
        if (!isNaN(num) && num > maxNum) maxNum = num;
    });
    const nextNum = maxNum + 1;

    // Felhasználónév kiszedése a csatorna eredeti nevéből
    let rawUser = channel.name.replace(/^ticket-/, '').replace(/-nyeremeny-\d+$/, '').replace(/-partner-\d+$/, '');
    const cleanUser = rawUser.split('-')[0] || 'user';
    const newName = `${cleanUser}-${nameSuffix}-${nextNum}`;

    // Megőrizzük a ticket nyitójának egyedi jogait
    const userOverwrites = channel.permissionOverwrites.cache.filter(
        o => o.id !== guild.id && o.id !== client.user.id
    );

    // Csatorna áthelyezése és átnevezése
    await channel.setParent(selectedCategory.id, { lockPermissions: false });
    await channel.setName(newName);

    // Jogosultságok visszatöltése a ticket nyitójának
    for (const [overwriteId] of userOverwrites) {
        await channel.permissionOverwrites.edit(overwriteId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        }).catch(() => {});
    }

    return { newName, categoryName: selectedCategory.name };
}

// SORSOLÓ FÜGGVÉNY
async function endGiveaway(gwData) {
    try {
        const checkDb = await Giveaway.findOne({ messageId: gwData.messageId });
        if (!checkDb) return;

        const guild = client.guilds.cache.get(gwData.guildId);
        if (!guild) return;
        const channel = guild.channels.cache.get(gwData.channelId);
        if (!channel) return;
        
        const message = await channel.messages.fetch(gwData.messageId).catch(() => null);
        if (!message) return;

        const reaction = message.reactions.cache.get('🎉');
        let validUsers = [];
        
        if (reaction) {
            let lastId;
            while (true) {
                const options = { limit: 100 };
                if (lastId) options.after = lastId;
                const fetchedUsers = await reaction.users.fetch(options);
                if (fetchedUsers.size === 0) break;
                
                validUsers.push(...fetchedUsers.filter(user => !user.bot).map(user => user.id));
                lastId = fetchedUsers.last().id;
                if (fetchedUsers.size < 100) break;
            }
        }

        if (validUsers.length === 0) {
            const noWinnerEmbed = EmbedBuilder.from(message.embeds[0])
                .setDescription('A nyereményjáték lezárult!')
                .addFields({ name: 'Nyertes(ek)', value: 'Nincs résztvevő 😢', inline: false });
            await message.edit({ embeds: [noWinnerEmbed] });
            await channel.send({ content: 'A nyereményjáték véget ért, de senki sem jelentkezett.' });
        } else {
            const members = await guild.members.fetch({ user: validUsers }).catch(() => new Map());
            const participants = validUsers.map(userId => {
                const member = members.get(userId);
                const isBooster = member ? member.premiumSince !== null : false;
                const weight = isBooster ? (100 + gwData.boosterBonus) : 100;
                return { id: userId, weight: weight };
            });

            const winners = drawWinners(participants, gwData.winnerCount);
            const winnersMention = winners.map(id => `<@${id}>`).join(' ');

            let embedWinnerValue = winnersMention;
            if (embedWinnerValue.length > 1000) {
                embedWinnerValue = `🎉 **${winners.length} nyertes kisorsolva!** (Lásd az alábbi üzenetet)`;
            }

            const endEmbed = EmbedBuilder.from(message.embeds[0])
                .setDescription('A nyereményjáték lezárult!')
                .addFields({ name: 'Nyertes(ek)', value: embedWinnerValue, inline: false });

            await message.edit({ embeds: [endEmbed] });

            if (winnersMention.length <= 2000) {
                await channel.send({ content: winnersMention });
            } else {
                let currentMsg = "";
                for (const winnerId of winners) {
                    const mention = `<@${winnerId}> `;
                    if ((currentMsg + mention).length > 1900) {
                        await channel.send({ content: currentMsg });
                        currentMsg = "";
                    }
                    currentMsg += mention;
                }
                if (currentMsg.length > 0) {
                    await channel.send({ content: currentMsg });
                }
            }
        }
        
        checkDb.ended = true;
        await checkDb.save();

    } catch (error) {
        console.error("Hiba a giveaway lezárásakor:", error);
    }
}

// --- PARANCSOK DEFINIÁLÁSA ---
const commands = [
    new SlashCommandBuilder().setName('giveaway').setDescription('Nyereményjáték parancsok')
        .addSubcommand(subcommand => subcommand.setName('start').setDescription('Nyereményjáték indítása').addStringOption(option => option.setName('duration').setDescription('Időtartam (pl: 10s, 5m, 2h, 1d)').setRequired(true)).addStringOption(option => option.setName('prize').setDescription('Mi a nyeremény?').setRequired(true)).addIntegerOption(option => option.setName('winners').setDescription('Hány nyertes legyen?').setRequired(true).setMinValue(1)).addIntegerOption(option => option.setName('booster_bonus').setDescription('Hány %-kal legyen több esélye a Boostereknek? (Opcionális)').setMinValue(1)))
        .addSubcommand(subcommand => subcommand.setName('reroll').setDescription('Újrasorsolás a megadott számú új nyertesnek').addStringOption(option => option.setName('message_id').setDescription('A giveaway üzenetének az ID-ja').setRequired(true)).addIntegerOption(option => option.setName('winners').setDescription('Hány új nyertest sorsoljunk ki? (Alapértelmezett: 1)').setRequired(false).setMinValue(1)))
        .addSubcommand(subcommand => subcommand.setName('end').setDescription('Egy futó nyereményjáték azonnali leállítása és sorsolása').addStringOption(option => option.setName('message_id').setDescription('A futó giveaway üzenetének ID-ja').setRequired(true))),
    new SlashCommandBuilder().setName('ticket').setDescription('Ticket rendszer parancsok')
        .addSubcommand(subcommand => subcommand.setName('setup').setDescription('Ticket panel elküldése a jelenlegi csatornába'))
        .addSubcommand(subcommand => subcommand.setName('sorsolas').setDescription('Ticket áthelyezése a Nyereményjáték kategóriába'))
        .addSubcommand(subcommand => subcommand.setName('partner').setDescription('Ticket áthelyezése a Partner kategóriába')),
    new SlashCommandBuilder().setName('invites').setDescription('Meghívók lekérése')
        .addUserOption(option => option.setName('user').setDescription('Kinek a meghívóit szeretnéd megnézni? (Opcionális)'))
].map(command => command.toJSON());

// --- BOT INDÍTÁSA ---
client.once('ready', async () => {
    console.log(`Sikeresen bejelentkezve mint ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    updateStatus(client.guilds.cache.first());

    const activeGiveaways = await Giveaway.find({ ended: false });
    const now = Date.now();
    for (const gw of activeGiveaways) {
        const remainingTime = gw.endTime - now;
        if (remainingTime <= 0) {
            endGiveaway(gw);
        } else {
            setTimeout(() => endGiveaway(gw), remainingTime);
        }
    }
});

// --- ÚJ TAG ÉS MEGHÍVÓ FIGYELÉSE ---
client.on('guildMemberAdd', async (member) => {
    updateStatus(member.guild);
    try {
        const invites = await member.guild.invites.fetch();
        const inviter = invites.find(i => i.uses > 0); 
        if (inviter) {
            let data = await Invite.findOne({ guildId: member.guild.id, userId: inviter.inviter.id }) || new Invite({ guildId: member.guild.id, userId: inviter.inviter.id, invites: 0 });
            data.invites += 1;
            await data.save();
        }
    } catch (error) {}
});
client.on('guildMemberRemove', (member) => updateStatus(member.guild));

// --- CHAT ÜZENETEK FIGYELÉSE (.sorsolas ÉS .partner PREFIX PARANCSOK) ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const content = message.content.toLowerCase().trim();

    if (content === '.sorsolas' || content === '.partner') {
        await message.delete().catch(() => {});

        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            const replyMsg = await message.channel.send('❌ Nincs jogosultságod a ticket átmozgatásához!');
            return setTimeout(() => replyMsg.delete().catch(() => {}), 4000);
        }

        const categoryType = content === '.sorsolas' ? 'sorsolas' : 'partner';
        
        try {
            const result = await moveTicketCategory(message.channel, message.guild, categoryType);
            const replyMsg = await message.channel.send(`✅ Ticket áthelyezve a **${result.categoryName}** kategóriába! Új név: \`${result.newName}\``);
            setTimeout(() => replyMsg.delete().catch(() => {}), 4000);

        } catch (err) {
            console.error(err);
            const errorText = err.message ? err.message : 'Ellenőrizd a bot jogait!';
            const replyMsg = await message.channel.send(`❌ Hiba történt: ${errorText}`);
            setTimeout(() => replyMsg.delete().catch(() => {}), 6000);
        }
    }
});

// --- INTERAKCIÓK KEZELÉSE ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    if (interaction.isChatInputCommand()) {
        const userAvatar = interaction.user.displayAvatarURL({ forceStatic: false, size: 256 });
        const userDisplay = interaction.user.displayName || interaction.user.username;

        // INVITES
        if (interaction.commandName === 'invites') {
            const user = interaction.options.getUser('user') || interaction.user;
            const data = await Invite.findOne({ guildId: interaction.guild.id, userId: user.id });
            return interaction.reply({ content: `📩 **${user.username}** eddig **${data ? data.invites : 0}** embert hívott meg a szerverre!`, ephemeral: false });
        }

        // TICKET PARANCSOK
        if (interaction.commandName === 'ticket') {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'setup') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });
                const ticketEmbed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎫 Ügyfélszolgálat / Ticket Nyitása').setDescription('Kérdésed van, vagy segítségre van szükséged?\nKattints az alábbi gombra, hogy privát csatornát nyiss a csapattal!').setFooter({ text: 'Ticket Rendszer' });
                const ticketButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('📩 Ticket Nyitása').setStyle(ButtonStyle.Primary));
                await interaction.channel.send({ embeds: [ticketEmbed], components: [ticketButton] });
                return interaction.reply({ content: '✅ Ticket panel létrehozva!', ephemeral: true });
            }

            if (subcommand === 'sorsolas' || subcommand === 'partner') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                    return interaction.reply({ content: '❌ Nincs jogosultságod a ticket átmozgatásához!', ephemeral: true });
                }

                try {
                    const result = await moveTicketCategory(interaction.channel, interaction.guild, subcommand);
                    return interaction.reply({ content: `✅ Ticket áthelyezve a **${result.categoryName}** kategóriába! Új név: \`${result.newName}\``, ephemeral: true });
                } catch (err) {
                    console.error(err);
                    return interaction.reply({ content: `❌ Hiba történt: ${err.message || 'Ellenőrizd a bot jogait!'}`, ephemeral: true });
                }
            }
        }

        // GIVEAWAY
        if (interaction.commandName === 'giveaway') {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'start') {
                const durationMs = ms(interaction.options.getString('duration'));
                if (!durationMs) return interaction.reply({ content: '❌ Érvénytelen időformátum!', ephemeral: true });
                
                const prize = interaction.options.getString('prize');
                const winnerCount = interaction.options.getInteger('winners');
                const boosterBonus = interaction.options.getInteger('booster_bonus') || 0; 
                const endTime = Math.floor((Date.now() + durationMs) / 1000);

                const giveawayEmbed = new EmbedBuilder().setColor('#00f2fe').setAuthor({ name: userDisplay, iconURL: userAvatar }).setTitle('🎁 Nyereményjáték 🎁').setDescription('Reagálj a 🎉 emojival a jelentkezéshez!').addFields({ name: 'Nyeremény', value: prize, inline: false }, { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true }, { name: 'Indította', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Lejárat', value: `<t:${endTime}:f>`, inline: false }).setFooter({ text: 'Vége' }).setTimestamp(new Date(Date.now() + durationMs));
                if (boosterBonus > 0) giveawayEmbed.addFields({ name: '💎 Booster Bónusz', value: `+${boosterBonus}% esély a nyerésre!`, inline: false });

                const message = await interaction.reply({ embeds: [giveawayEmbed], fetchReply: true });
                await message.react('🎉');

                const newGiveaway = new Giveaway({ messageId: message.id, channelId: interaction.channelId, guildId: interaction.guildId, endTime: Date.now() + durationMs, prize: prize, winnerCount: winnerCount, boosterBonus: boosterBonus });
                await newGiveaway.save();

                setTimeout(() => endGiveaway(newGiveaway), durationMs);
            }

            if (subcommand === 'reroll') {
                const messageId = interaction.options.getString('message_id');
                const rerollCount = interaction.options.getInteger('winners') || 1;
                await interaction.deferReply({ ephemeral: true });

                const gwData = await Giveaway.findOne({ messageId: messageId });
                if (!gwData) return interaction.editReply({ content: '❌ Nem található nyereményjáték ezzel az ID-val az adatbázisban!' });

                const channel = interaction.guild.channels.cache.get(gwData.channelId);
                if (!channel) return interaction.editReply({ content: '❌ Nem található a csatorna!' });

                const message = await channel.messages.fetch(gwData.messageId).catch(() => null);
                if (!message) return interaction.editReply({ content: '❌ Nem található a nyereményjáték üzenet!' });

                const reaction = message.reactions.cache.get('🎉');
                let validUsers = [];

                if (reaction) {
                    let lastId;
                    while (true) {
                        const options = { limit: 100 };
                        if (lastId) options.after = lastId;
                        const fetchedUsers = await reaction.users.fetch(options);
                        if (fetchedUsers.size === 0) break;
                        
                        validUsers.push(...fetchedUsers.filter(user => !user.bot).map(user => user.id));
                        lastId = fetchedUsers.last().id;
                        if (fetchedUsers.size < 100) break;
                    }
                }

                if (validUsers.length === 0) return interaction.editReply({ content: '❌ Nincs érvényes jelentkező!' });

                const members = await interaction.guild.members.fetch({ user: validUsers }).catch(() => new Map());
                const participants = validUsers.map(userId => {
                    const member = members.get(userId);
                    const isBooster = member ? member.premiumSince !== null : false;
                    const weight = isBooster ? (100 + gwData.boosterBonus) : 100;
                    return { id: userId, weight: weight };
                });

                const winners = drawWinners(participants, rerollCount);
                if (winners.length === 0) return interaction.editReply({ content: '❌ Nem sikerült nyertest sorsolni.' });

                const winnersMention = winners.map(id => `<@${id}>`).join(' ');

                const header = `🎲 **Újrasorsolás (${winners.length} új nyertes)!** A nyeremény: **${gwData.prize}**! 🎉\n\n`;
                
                if ((header + winnersMention).length <= 2000) {
                    await channel.send({ content: header + winnersMention });
                } else {
                    await channel.send({ content: header });
                    let currentMsg = "";
                    for (const winnerId of winners) {
                        const mention = `<@${winnerId}> `;
                        if ((currentMsg + mention).length > 1900) {
                            await channel.send({ content: currentMsg });
                            currentMsg = "";
                        }
                        currentMsg += mention;
                    }
                    if (currentMsg.length > 0) {
                        await channel.send({ content: currentMsg });
                    }
                }

                return interaction.editReply({ content: `✅ Sikeresen kisorsoltál ${winners.length} új nyertest!` });
            }

            if (subcommand === 'end') {
                const messageId = interaction.options.getString('message_id');
                await interaction.deferReply({ ephemeral: true });
                const gwData = await Giveaway.findOne({ messageId: messageId });
                
                if (!gwData) return interaction.editReply({ content: '❌ Ezt a játékot nem találom az adatbázisban!' });

                gwData.ended = false;
                await endGiveaway(gwData);
                await interaction.editReply({ content: '✅ A nyereményjáték sorsolása megtörtént!' });
            }
        }
    }

    // GOMBOK KEZELÉSE (Ticket)
    if (interaction.isButton()) {
        if (interaction.customId === 'open_ticket') {
            const ticketName = `ticket-${interaction.user.username}`;
            if (interaction.guild.channels.cache.find(c => c.name === ticketName.toLowerCase())) return interaction.reply({ content: `❌ Már van nyitott ticketed!`, ephemeral: true });

            const ticketChannel = await interaction.guild.channels.create({
                name: ticketName, type: ChannelType.GuildText, parent: TICKET_CONFIG.DEFAULT_PARENT,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
                ]
            });

            const welcomeEmbed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎫 Új Ticket').setDescription(`Üdv, <@${interaction.user.id}>!\nKérjük írd le miben segíthetünk.`);
            const closeButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Ticket Lezárása (Csak Admin)').setStyle(ButtonStyle.Danger));

            await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [welcomeEmbed], components: [closeButton] });
            await interaction.reply({ content: `✅ Ticket nyitva: <#${ticketChannel.id}>`, ephemeral: true });
        }

        if (interaction.customId === 'close_ticket') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) return interaction.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });
            await interaction.reply({ content: '🔒 Ticket lezárása és leirat mentése...' });

            try {
                const messages = await interaction.channel.messages.fetch({ limit: 100 });
                let transcriptData = `TICKET LEIRAT - ${interaction.channel.name}\n\n`;
                messages.reverse().forEach(msg => transcriptData += `[${new Date(msg.createdTimestamp).toLocaleString('hu-HU')}] ${msg.author.tag}: ${msg.content}\n`);

                const transcriptAttachment = new AttachmentBuilder(Buffer.from(transcriptData, 'utf-8'), { name: `${interaction.channel.name}-transcript.txt` });
                let logChannel = interaction.guild.channels.cache.find(c => c.name === 'ticket-logok') || await interaction.guild.channels.create({ name: 'ticket-logok', type: ChannelType.GuildText, permissionOverwrites: [{ id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] });

                const logEmbed = new EmbedBuilder().setTitle('📝 Ticket Lezárva').setColor('#e74c3c').addFields({ name: 'Neve', value: interaction.channel.name, inline: true }, { name: 'Lezárta', value: interaction.user.tag, inline: true }).setTimestamp();
                await logChannel.send({ embeds: [logEmbed], files: [transcriptAttachment] });

                setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
            } catch (error) { interaction.editReply({ content: '❌ Hiba történt!' }); }
        }
    }
});

client.login(process.env.TOKEN);
