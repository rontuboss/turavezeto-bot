require('dotenv').config();
const express = require('express');
const app = express();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder,
    Partials,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    AttachmentBuilder // Ez kell a leirat (transcript) fájlhoz!
} = require('discord.js');
const ms = require('ms');

// --- WEB SZERVER A RENDERNEK ---
app.get('/', (req, res) => res.send('A bot tökéletesen fut!'));
app.listen(process.env.PORT || 3000, () => console.log('A webes kiszolgáló elindult.'));

// --- DISCORD KLIENS BEÁLLÍTÁSA ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// --- PARANCSOK DEFINIÁLÁSA ---
const commands = [
    // GIVEAWAY PARANCSOK
    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Nyereményjáték parancsok')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Nyereményjáték indítása')
                .addStringOption(option => 
                    option.setName('duration').setDescription('Időtartam (pl: 10s, 5m, 2h, 1d)').setRequired(true))
                .addStringOption(option => 
                    option.setName('prize').setDescription('Mi a nyeremény?').setRequired(true))
                .addIntegerOption(option => 
                    option.setName('winners').setDescription('Hány nyertes legyen?').setRequired(true).setMinValue(1))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reroll')
                .setDescription('Újrasorsolás egy korábbi játékhoz az üzenet ID-ja alapján')
                .addStringOption(option => 
                    option.setName('message_id').setDescription('A giveaway üzenetének az ID-ja').setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('end')
                .setDescription('Egy futó nyereményjáték azonnali leállítása és sorsolása')
                .addStringOption(option => 
                    option.setName('message_id').setDescription('A futó giveaway üzenetének ID-ja').setRequired(true))
        ),
    
    // TICKET PARANCS
    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket rendszer parancsok')
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Ticket panel elküldése a jelenlegi csatornába')
        )
].map(command => command.toJSON());

// --- STÁTUSZ FRISSÍTŐ FUNKCIÓ ---
function updateStatus(guild) {
    if (guild) {
        client.user.setPresence({
            activities: [{ name: `👥 ${guild.memberCount} tag | /giveaway`, type: 4 }],
            status: 'online'
        });
    }
}

// --- BOT INDÍTÁSA ---
client.once('ready', async () => {
    console.log(`Sikeresen bejelentkezve mint ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('A parancsok regisztrálva lettek!');
    } catch (error) {
        console.error(error);
    }
    updateStatus(client.guilds.cache.first());
});

client.on('guildMemberAdd', (member) => updateStatus(member.guild));
client.on('guildMemberRemove', (member) => updateStatus(member.guild));

function drawWinners(usersArray, count) {
    const shuffled = [...usersArray].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// --- INTERAKCIÓK KEZELÉSE ---
client.on('interactionCreate', async (interaction) => {
    const userAvatar = interaction.user.displayAvatarURL({ forceStatic: false, size: 256 });
    const userDisplay = interaction.user.displayName || interaction.user.username;

    // 1. SLASH PARANCSOK
    if (interaction.isChatInputCommand()) {
        
        // --- TICKET SETUP ---
        if (interaction.commandName === 'ticket') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: '❌ Nincs jogosultságod ezt a parancsot használni!', ephemeral: true });
            }

            const ticketEmbed = new EmbedBuilder()
                .setColor('#00f2fe')
                .setTitle('🎫 Ügyfélszolgálat / Ticket Nyitása')
                .setDescription('Kérdésed van, vagy segítségre van szükséged?\nKattints az alábbi gombra, hogy privát csatornát nyiss a csapattal!')
                .setFooter({ text: 'Ticket Rendszer' });

            const ticketButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('open_ticket')
                        .setLabel('📩 Ticket Nyitása')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.channel.send({ embeds: [ticketEmbed], components: [ticketButton] });
            return interaction.reply({ content: '✅ Ticket panel sikeresen létrehozva!', ephemeral: true });
        }

        // --- GIVEAWAY PARANCSOK ---
        if (interaction.commandName === 'giveaway') {
            const subcommand = interaction.options.getSubcommand();

            // START ALPARANCS
            if (subcommand === 'start') {
                const durationInput = interaction.options.getString('duration');
                const prize = interaction.options.getString('prize');
                const winnerCount = interaction.options.getInteger('winners');
                
                const durationMs = ms(durationInput);
                if (!durationMs) {
                    return interaction.reply({ content: '❌ Érvénytelen időformátum!', ephemeral: true });
                }

                const endTime = Math.floor((Date.now() + durationMs) / 1000);

                const giveawayEmbed = new EmbedBuilder()
                    .setColor('#00f2fe') 
                    .setAuthor({ name: userDisplay, iconURL: userAvatar })
                    .setTitle('🎁 Nyereményjáték 🎁')
                    .setDescription('Reagálj a 🎉 emojival a jelentkezéshez!')
                    .addFields(
                        { name: 'Nyeremény', value: prize, inline: false },
                        { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true },
                        { name: 'Indította', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'Lejárat', value: `<t:${endTime}:f>`, inline: false }
                    )
                    .setFooter({ text: 'Vége' })
                    .setTimestamp(new Date(Date.now() + durationMs));

                const message = await interaction.reply({ embeds: [giveawayEmbed], fetchReply: true });
                await message.react('🎉');

                setTimeout(async () => {
                    try {
                        const targetMessage = await interaction.channel.messages.fetch(message.id);
                        if (targetMessage.embeds[0].description.includes('lezárult')) return;

                        const reaction = targetMessage.reactions.cache.get('🎉');
                        let users = [];
                        if (reaction) {
                            const reactedUsers = await reaction.users.fetch();
                            users = reactedUsers.filter(user => !user.bot).map(user => user.id);
                        }

                        if (users.length === 0) {
                            const noWinnerEmbed = new EmbedBuilder()
                                .setColor('#00f2fe')
                                .setAuthor({ name: userDisplay, iconURL: userAvatar })
                                .setTitle('🎁 Nyereményjáték 🎁')
                                .setDescription('A nyereményjáték lezárult!')
                                .addFields(
                                    { name: 'Nyeremény', value: prize, inline: false },
                                    { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true },
                                    { name: 'Indította', value: `<@${interaction.user.id}>`, inline: true },
                                    { name: 'Nyertes(ek)', value: 'Nincs résztvevő 😢', inline: false }
                                )
                                .setFooter({ text: 'Vége' })
                                .setTimestamp(new Date());

                            await targetMessage.edit({ embeds: [noWinnerEmbed] });
                        } else {
                            const winners = drawWinners(users, winnerCount);
                            const winnersMention = winners.map(id => `<@${id}>`).join(', ');

                            const endEmbed = new EmbedBuilder()
                                .setColor('#00f2fe')
                                .setAuthor({ name: userDisplay, iconURL: userAvatar })
                                .setTitle('🎁 Nyereményjáték 🎁')
                                .setDescription('A nyereményjáték lezárult!')
                                .addFields(
                                    { name: 'Nyeremény', value: prize, inline: false },
                                    { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true },
                                    { name: 'Indította', value: `<@${interaction.user.id}>`, inline: true },
                                    { name: 'Nyertes(ek)', value: winnersMention, inline: false }
                                )
                                .setFooter({ text: 'Vége' })
                                .setTimestamp(new Date());

                            await targetMessage.edit({ embeds: [endEmbed] });

                            let congratulationText = winners.length > 1 
                                ? `🎉 Gratulálok ${winnersMention}! A nyereményetek: **${prize}/fő**! 🎉`
                                : `🎉 Gratulálok ${winnersMention}! A nyereményed: **${prize}**! 🎉`;
                            
                            await interaction.channel.send({ content: congratulationText });
                        }
                    } catch (error) {
                        console.error(error);
                    }
                }, durationMs);
            }

            // REROLL
            if (subcommand === 'reroll') {
                const messageId = interaction.options.getString('message_id');
                await interaction.deferReply({ ephemeral: true });
                try {
                    const targetMessage = await interaction.channel.messages.fetch(messageId);
                    if (!targetMessage.embeds || targetMessage.embeds.length === 0 || !targetMessage.embeds[0].title.includes('Nyereményjáték')) {
                        return interaction.editReply({ content: '❌ A megadott ID nem egy érvényes nyereményjáték üzenethez tartozik!' });
                    }
                    const reaction = targetMessage.reactions.cache.get('🎉');
                    let users = [];
                    if (reaction) {
                        const reactedUsers = await reaction.users.fetch();
                        users = reactedUsers.filter(user => !user.bot).map(user => user.id);
                    }
                    if (users.length === 0) {
                        return interaction.editReply({ content: '❌ Nem találtam egyetlen érvényes reakciót sem ezen az üzeneten.' });
                    }
                    const oldEmbed = targetMessage.embeds[0];
                    const prizeField = oldEmbed.fields.find(f => f.name === 'Nyeremény');
                    const prize = prizeField ? prizeField.value : 'Ismeretlen nyeremény';
                    const winnerCountField = oldEmbed.fields.find(f => f.name === 'Nyertesek száma');
                    const winnerCount = winnerCountField ? parseInt(winnerCountField.value) : 1;
                    const winners = drawWinners(users, winnerCount);
                    const winnersMention = winners.map(id => `<@${id}>`).join(', ');
                    const rerollEmbed = new EmbedBuilder()
                        .setColor('#00f2fe')
                        .setAuthor({ name: oldEmbed.author ? oldEmbed.author.name : userDisplay, iconURL: oldEmbed.author ? oldEmbed.author.iconURL : userAvatar })
                        .setTitle('🎲 Nyereményjáték 🎲')
                        .setDescription('A nyereményjátékot újra sorsolták!')
                        .addFields(
                            { name: 'Nyeremény', value: prize, inline: false },
                            { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true },
                            { name: 'Indította', value: oldEmbed.fields.find(f => f.name === 'Indította').value, inline: true },
                            { name: 'Nyertes(ek)', value: winnersMention, inline: false }
                        )
                        .setFooter({ text: 'Vége' })
                        .setTimestamp(oldEmbed.timestamp ? new Date(oldEmbed.timestamp) : new Date());
                    await targetMessage.edit({ embeds: [rerollEmbed] });
                    let congratulationText = winners.length > 1
                        ? `🎲 **Újrasorsolás!** Gratulálok ${winnersMention}! A nyereményetek: **${prize}/fő**! 🎉`
                        : `🎲 **Újrasorsolás!** Gratulálok ${winnersMention}! A nyereményed: **${prize}**! 🎉`;
                    await interaction.channel.send({ content: congratulationText });
                    await interaction.editReply({ content: '✅ Az újrasorsolás sikeresen lefutott!' });
                } catch (error) {
                    return interaction.editReply({ content: '❌ Nem sikerült betölteni az üzenetet.' });
                }
            }

            // END
            if (subcommand === 'end') {
                const messageId = interaction.options.getString('message_id');
                await interaction.deferReply({ ephemeral: true });
                try {
                    const targetMessage = await interaction.channel.messages.fetch(messageId);
                    if (!targetMessage.embeds || targetMessage.embeds.length === 0 || !targetMessage.embeds[0].title.includes('Nyereményjáték')) {
                        return interaction.editReply({ content: '❌ A megadott ID nem egy érvényes nyereményjáték üzenethez tartozik!' });
                    }
                    if (targetMessage.embeds[0].description.includes('lezárult')) {
                        return interaction.editReply({ content: '❌ Ez a nyereményjáték már lezárult, nem lehet újra leállítani!' });
                    }
                    const reaction = targetMessage.reactions.cache.get('🎉');
                    let users = [];
                    if (reaction) {
                        const reactedUsers = await reaction.users.fetch();
                        users = reactedUsers.filter(user => !user.bot).map(user => user.id);
                    }
                    const oldEmbed = targetMessage.embeds[0];
                    const prizeField = oldEmbed.fields.find(f => f.name === 'Nyeremény');
                    const prize = prizeField ? prizeField.value : 'Ismeretlen nyeremény';
                    const winnerCountField = oldEmbed.fields.find(f => f.name === 'Nyertesek száma');
                    const winnerCount = winnerCountField ? parseInt(winnerCountField.value) : 1;
                    if (users.length === 0) {
                        const noWinnerEmbed = new EmbedBuilder()
                            .setColor('#00f2fe')
                            .setAuthor({ name: oldEmbed.author ? oldEmbed.author.name : userDisplay, iconURL: oldEmbed.author ? oldEmbed.author.iconURL : userAvatar })
                            .setTitle('🎁 Nyereményjáték 🎁')
                            .setDescription('A nyereményjáték lezárult! (Idő előtt leállítva)')
                            .addFields(
                                { name: 'Nyeremény', value: prize, inline: false },
                                { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true },
                                { name: 'Indította', value: oldEmbed.fields.find(f => f.name === 'Indította').value, inline: true },
                                { name: 'Nyertes(ek)', value: 'Nincs résztvevő 😢', inline: false }
                            )
                            .setFooter({ text: 'Vége' })
                            .setTimestamp(new Date());
                        await targetMessage.edit({ embeds: [noWinnerEmbed] });
                        return interaction.editReply({ content: '✅ A játékot leállítottad, de nem volt jelentkező.' });
                    }
                    const winners = drawWinners(users, winnerCount);
                    const winnersMention = winners.map(id => `<@${id}>`).join(', ');
                    const endEmbed = new EmbedBuilder()
                        .setColor('#00f2fe')
                        .setAuthor({ name: oldEmbed.author ? oldEmbed.author.name : userDisplay, iconURL: oldEmbed.author ? oldEmbed.author.iconURL : userAvatar })
                        .setTitle('🎁 Nyereményjáték 🎁')
                        .setDescription('A nyereményjáték lezárult! (Idő előtt leállítva)')
                        .addFields(
                            { name: 'Nyeremény', value: prize, inline: false },
                            { name: 'Nyertesek száma', value: `${winnerCount}`, inline: true },
                            { name: 'Indította', value: oldEmbed.fields.find(f => f.name === 'Indította').value, inline: true },
                            { name: 'Nyertes(ek)', value: winnersMention, inline: false }
                        )
                        .setFooter({ text: 'Vége' })
                        .setTimestamp(new Date());
                    await targetMessage.edit({ embeds: [endEmbed] });
                    let congratulationText = winners.length > 1
                        ? `🛑 **A játék véget ért!** Gratulálok ${winnersMention}! A nyereményetek: **${prize}/fő**! 🎉`
                        : `🛑 **A játék véget ért!** Gratulálok ${winnersMention}! A nyereményed: **${prize}**! 🎉`;
                    await interaction.channel.send({ content: congratulationText });
                    await interaction.editReply({ content: '✅ A nyereményjátékot sikeresen leállítottad, a sorsolás megtörtént!' });
                } catch (error) {
                    return interaction.editReply({ content: '❌ Nem sikerült betölteni az üzenetet.' });
                }
            }
        }
    }

    // 2. GOMBOK KEZELÉSE (Ticket logika)
    if (interaction.isButton()) {
        
        // Ticket Nyitása
        if (interaction.customId === 'open_ticket') {
            const ticketName = `ticket-${interaction.user.username}`;

            const existingChannel = interaction.guild.channels.cache.find(c => c.name === ticketName.toLowerCase());
            if (existingChannel) {
                return interaction.reply({ content: `❌ Már van egy nyitott ticketed itt: <#${existingChannel.id}>`, ephemeral: true });
            }

            const ticketChannel = await interaction.guild.channels.create({
                name: ticketName,
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
                ]
            });

            const welcomeEmbed = new EmbedBuilder()
                .setColor('#00f2fe')
                .setTitle('🎫 Új Ticket')
                .setDescription(`Üdvözlünk, <@${interaction.user.id}>!\nKérjük írd le miben segíthetünk.\n\n*A ticketet csak a moderátorok tudják lezárni.*`);

            const closeButton = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('close_ticket')
                        .setLabel('🔒 Ticket Lezárása (Csak Admin)')
                        .setStyle(ButtonStyle.Danger)
                );

            await ticketChannel.send({ content: `<@${interaction.user.id}>`, embeds: [welcomeEmbed], components: [closeButton] });
            await interaction.reply({ content: `✅ Ticket sikeresen létrehozva: <#${ticketChannel.id}>`, ephemeral: true });
        }

        // Ticket Bezárása (Csak Adminoknak + Transcript)
        if (interaction.customId === 'close_ticket') {
            
            // 1. Jogosultság ellenőrzése (Csak aki tud csatornát kezelni, az tudja lezárni)
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({ content: '❌ Ehhez nincs jogosultságod! Csak a moderátorok zárhatják le a ticketet.', ephemeral: true });
            }

            await interaction.reply({ content: '🔒 A ticket lezárása és a leirat (transcript) mentése folyamatban...' });

            try {
                // 2. Üzenetek kimentése (Transcript)
                const messages = await interaction.channel.messages.fetch({ limit: 100 });
                let transcriptData = `TICKET LEIRAT - ${interaction.channel.name}\nLezárva: ${new Date().toLocaleString('hu-HU')}\n\n`;
                
                messages.reverse().forEach(msg => {
                    transcriptData += `[${new Date(msg.createdTimestamp).toLocaleString('hu-HU')}] ${msg.author.tag}: ${msg.content}\n`;
                });

                const transcriptAttachment = new AttachmentBuilder(Buffer.from(transcriptData, 'utf-8'), { name: `${interaction.channel.name}-transcript.txt` });

                // 3. Log csatorna megkeresése vagy létrehozása
                let logChannel = interaction.guild.channels.cache.find(c => c.name === 'ticket-logok');
                if (!logChannel) {
                    logChannel = await interaction.guild.channels.create({
                        name: 'ticket-logok',
                        type: ChannelType.GuildText,
                        permissionOverwrites: [
                            { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // Rejtett mindenki elől
                            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                        ]
                    });
                }

                // 4. Mentés elküldése a log csatornába
                const logEmbed = new EmbedBuilder()
                    .setTitle('📝 Ticket Lezárva')
                    .setColor('#e74c3c')
                    .addFields(
                        { name: 'Ticket Neve', value: interaction.channel.name, inline: true },
                        { name: 'Lezárta', value: interaction.user.tag, inline: true }
                    )
                    .setTimestamp();

                await logChannel.send({ embeds: [logEmbed], files: [transcriptAttachment] });

                // 5. Ticket törlése 5 másodperc múlva
                setTimeout(() => {
                    interaction.channel.delete().catch(err => console.error('Nem sikerült törölni a csatornát:', err));
                }, 5000);

            } catch (error) {
                console.error(error);
                interaction.editReply({ content: '❌ Hiba történt a leirat mentésekor!' });
            }
        }
    }
});

client.login(process.env.TOKEN);