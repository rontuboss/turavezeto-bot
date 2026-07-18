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

// --- ADATBÁZIS CSATLAKOZÁS ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Adatbázis sikeresen csatlakoztatva!'))
    .catch(err => console.error('❌ Adatbázis hiba:', err));

// Sémák (Meghívók és Nyereményjátékok)
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

// --- WEB SZERVER A RENDERNEK (Ez tartja ébren az UptimeRobottal) ---
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

// ADATBÁZISOS SORSOLÓ FÜGGVÉNY
async function endGiveaway(gwData) {
    try {
        const checkDb = await Giveaway.findOne({ messageId: gwData.messageId });
        if (!checkDb || checkDb.ended) return; // Ha már lezárult, nem sorsol újra

        const guild = client.guilds.cache.get(gwData.guildId);
        if (!guild) return;
        const channel = guild.channels.cache.get(gwData.channelId);
        if (!channel) return;
        
        const message = await channel.messages.fetch(gwData.messageId).catch(() => null);
        if (!message) return;

        const reaction = message.reactions.cache.get('🎉');
        let validUsers = [];
        if (reaction) {
            const reactedUsers = await reaction.users.fetch();
            validUsers = reactedUsers.filter(user => !user.bot).map(user => user.id);
        }

        if (validUsers.length === 0) {
            const noWinnerEmbed = EmbedBuilder.from(message.embeds[0])
                .setDescription('A nyereményjáték lezárult!')
                .addFields({ name: 'Nyertes(ek)', value: 'Nincs résztvevő 😢', inline: false });
            await message.edit({ embeds: [noWinnerEmbed] });
            await channel.send({ content: 'A nyereményjáték véget ért, de senki sem jelentkezett.' });
        } else {
            const members = await guild.members.fetch({ user: validUsers });
            const participants = validUsers.map(userId => {
                const member = members.get(userId);
                const isBooster = member ? member.premiumSince !== null : false;
                const weight = isBooster ? (100 + gwData.boosterBonus) : 100;
                return { id: userId, weight: weight };
            });

            const winners = drawWinners(participants, gwData.winnerCount);
            const winnersMention = winners.map(id => `<@${id}>`).join(', ');

            const endEmbed = EmbedBuilder.from(message.embeds[0])
                .setDescription('A nyereményjáték lezárult!')
                .addFields({ name: 'Nyertes(ek)', value: winnersMention, inline: false });

            await message.edit({ embeds: [endEmbed] });

            let congratulationText = winners.length > 1 
                ? `🎉 Gratulálok ${winnersMention}! A nyereményetek: **${gwData.prize}/fő**! 🎉`
                : `🎉 Gratulálok ${winnersMention}! A nyereményed: **${gwData.prize}**! 🎉`;
            
            await channel.send({ content: congratulationText });
        }
        
        // Adatbázisban beállítjuk lezártnak
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
        .addSubcommand(subcommand => subcommand.setName('reroll').setDescription('Újrasorsolás egy korábbi játékhoz az üzenet ID-ja alapján').addStringOption(option => option.setName('message_id').setDescription('A giveaway üzenetének az ID-ja').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('end').setDescription('Egy futó nyereményjáték azonnali leállítása és sorsolása').addStringOption(option => option.setName('message_id').setDescription('A futó giveaway üzenetének ID-ja').setRequired(true))),
    new SlashCommandBuilder().setName('ticket').setDescription('Ticket rendszer parancsok')
        .addSubcommand(subcommand => subcommand.setName('setup').setDescription('Ticket panel elküldése a jelenlegi csatornába')),
    new SlashCommandBuilder().setName('invites').setDescription('Meghívók lekérése')
        .addUserOption(option => option.setName('user').setDescription('Kinek a meghívóit szeretnéd megnézni? (Opcionális)'))
].map(command => command.toJSON());

// --- BOT INDÍTÁSA (ÉS SORSOLÁSOK FOLYTATÁSA) ---
client.once('ready', async () => {
    console.log(`Sikeresen bejelentkezve mint ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    updateStatus(client.guilds.cache.first());

    // Félbemaradt nyereményjátékok visszatöltése memóriába bot induláskor!
    const activeGiveaways = await Giveaway.find({ ended: false });
    const now = Date.now();
    for (const gw of activeGiveaways) {
        const remainingTime = gw.endTime - now;
        if (remainingTime <= 0) {
            endGiveaway(gw); // Ha már lejárt, amíg offline volt a bot, azonnal sorsol!
        } else {
            setTimeout(() => endGiveaway(gw), remainingTime); // Ha még van idő, folytatja!
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

        // TICKET SETUP
        if (interaction.commandName === 'ticket') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });
            const ticketEmbed = new EmbedBuilder().setColor('#00f2fe').setTitle('🎫 Ügyfélszolgálat / Ticket Nyitása').setDescription('Kérdésed van, vagy segítségre van szükséged?\nKattints az alábbi gombra, hogy privát csatornát nyiss a csapattal!').setFooter({ text: 'Ticket Rendszer' });
            const ticketButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('📩 Ticket Nyitása').setStyle(ButtonStyle.Primary));
            await interaction.channel.send({ embeds: [ticketEmbed], components: [ticketButton] });
            return interaction.reply({ content: '✅ Ticket panel létrehozva!', ephemeral: true });
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

                // Mentjük a nyereményjátékot az adatbázisba!
                const newGiveaway = new Giveaway({ messageId: message.id, channelId: interaction.channelId, guildId: interaction.guildId, endTime: Date.now() + durationMs, prize: prize, winnerCount: winnerCount, boosterBonus: boosterBonus });
                await newGiveaway.save();

                setTimeout(() => endGiveaway(newGiveaway), durationMs);
            }

            if (subcommand === 'reroll') {
                const messageId = interaction.options.getString('message_id');
                await interaction.deferReply({ ephemeral: true });
                try {
                    const targetMessage = await interaction.channel.messages.fetch(messageId);
                    if (!targetMessage.embeds || targetMessage.embeds.length === 0 || !targetMessage.embeds[0].title.includes('Nyereményjáték')) return interaction.editReply({ content: '❌ Nem érvényes nyereményjáték üzenet!' });
                    const reaction = targetMessage.reactions.cache.get('🎉');
                    let validUsers = [];
                    if (reaction) validUsers = (await reaction.users.fetch()).filter(user => !user.bot).map(user => user.id);
                    if (validUsers.length === 0) return interaction.editReply({ content: '❌ Nincs érvényes jelentkező.' });
                    
                    const oldEmbed = targetMessage.embeds[0];
                    const prize = oldEmbed.fields.find(f => f.name === 'Nyeremény')?.value || 'Ismeretlen nyeremény';
                    const winnerCount = parseInt(oldEmbed.fields.find(f => f.name === 'Nyertesek száma')?.value || 1);
                    const boosterBonus = parseInt(oldEmbed.fields.find(f => f.name === '💎 Booster Bónusz')?.value?.replace(/\D/g, '') || 0);

                    const members = await targetMessage.guild.members.fetch({ user: validUsers });
                    const participants = validUsers.map(userId => {
                        const member = members.get(userId);
                        return { id: userId, weight: (member && member.premiumSince !== null) ? (100 + boosterBonus) : 100 };
                    });

                    const winners = drawWinners(participants, winnerCount);
                    const winnersMention = winners.map(id => `<@${id}>`).join(', ');
                    
                    const rerollEmbed = EmbedBuilder.from(oldEmbed);
                    const winnerFieldIndex = rerollEmbed.data.fields.findIndex(f => f.name === 'Nyertes(ek)');
                    if (winnerFieldIndex !== -1) rerollEmbed.data.fields[winnerFieldIndex].value = winnersMention;
                    else rerollEmbed.addFields({ name: 'Nyertes(ek)', value: winnersMention, inline: false });

                    await targetMessage.edit({ embeds: [rerollEmbed] });
                    await interaction.channel.send({ content: `🎲 **Újrasorsolás!** Gratulálok ${winnersMention}! A nyeremény: **${prize}**! 🎉` });
                    await interaction.editReply({ content: '✅ Az újrasorsolás sikeresen lefutott!' });
                } catch (error) { return interaction.editReply({ content: '❌ Hiba történt.' }); }
            }

            if (subcommand === 'end') {
                const messageId = interaction.options.getString('message_id');
                await interaction.deferReply({ ephemeral: true });
                const gwData = await Giveaway.findOne({ messageId: messageId });
                
                if (!gwData) return interaction.editReply({ content: '❌ Ezt a játékot nem találom az adatbázisban!' });
                if (gwData.ended) return interaction.editReply({ content: '❌ Ez a nyereményjáték már lezárult!' });

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
                name: ticketName, type: ChannelType.GuildText, parent: '1527688497593585746',
                permissionOverwrites: [{ id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }, { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }]
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