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
    Partials
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
    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Nyereményjáték parancsok')
        // 1. Alparancs: START
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
        // 2. Alparancs: REROLL
        .addSubcommand(subcommand =>
            subcommand
                .setName('reroll')
                .setDescription('Újrasorsolás egy korábbi játékhoz az üzenet ID-ja alapján')
                .addStringOption(option => 
                    option.setName('message_id').setDescription('A giveaway üzenetének az ID-ja').setRequired(true))
        )
        // 3. Alparancs: END (A te kérésedre átnevezve)
        .addSubcommand(subcommand =>
            subcommand
                .setName('end')
                .setDescription('Egy futó nyereményjáték azonnali leállítása és sorsolása')
                .addStringOption(option => 
                    option.setName('message_id').setDescription('A futó giveaway üzenetének ID-ja').setRequired(true))
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
        console.log('Slash parancsok frissítése...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('A parancsok sikeresen regisztrálva lettek!');
    } catch (error) {
        console.error('Hiba a regisztráció során:', error);
    }

    updateStatus(client.guilds.cache.first());
});

// --- TAGOK VALÓS IDEJŰ FIGYELÉSE ---
client.on('guildMemberAdd', (member) => updateStatus(member.guild));
client.on('guildMemberRemove', (member) => updateStatus(member.guild));

// --- SEGÉDFUNKCIÓ A SORSOLÁSHOZ ---
function drawWinners(usersArray, count) {
    const shuffled = [...usersArray].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// --- GIVEAWAY, REROLL ÉS END LOGIKA ---
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const userAvatar = interaction.user.displayAvatarURL({ forceStatic: false, size: 256 });
    const userDisplay = interaction.user.displayName || interaction.user.username;

    if (interaction.commandName === 'giveaway') {
        const subcommand = interaction.options.getSubcommand();

        // --- 1. START ALPARANCS ---
        if (subcommand === 'start') {
            const durationInput = interaction.options.getString('duration');
            const prize = interaction.options.getString('prize');
            const winnerCount = interaction.options.getInteger('winners');
            
            const durationMs = ms(durationInput);
            if (!durationMs) {
                return interaction.reply({ 
                    content: '❌ Érvénytelen időformátum! Használj ilyesmit: `30s`, `5m`, `2h`, `1d`.', 
                    ephemeral: true 
                });
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

            // Eredeti időzítő
            setTimeout(async () => {
                try {
                    const targetMessage = await interaction.channel.messages.fetch(message.id);
                    
                    // BIZTONSÁGI ELLENŐRZÉS: Ha már leállították az end paranccsal, ne fusson le!
                    if (targetMessage.embeds[0].description.includes('lezárult')) return;

                    const reaction = targetMessage.reactions.cache.get('🎉');
                    let users = [];
                    if (reaction) {
                        const reactedUsers = await reaction.users.fetch();
                        users = reactedUsers.filter(user => !user.bot).map(user => user.id);
                    }

                    if (users.length === 0) {
                        const noWinnerEmbed = new EmbedBuilder()
                            .setColor('#4f545c')
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
                            .setColor('#23272a')
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
                    console.error('Hiba a sorsolás során:', error);
                }
            }, durationMs);
        }

        // --- 2. REROLL ALPARANCS ---
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
                    .setColor('#f0932b')
                    .setAuthor({ 
                        name: oldEmbed.author ? oldEmbed.author.name : userDisplay, 
                        iconURL: oldEmbed.author ? oldEmbed.author.iconURL : userAvatar 
                    })
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
                console.error(error);
                return interaction.editReply({ content: '❌ Nem sikerült betölteni az üzenetet. Biztos, hogy jó ID-t adtál meg?' });
            }
        }

        // --- 3. END ALPARANCS ---
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
                        .setColor('#4f545c')
                        .setAuthor({ 
                            name: oldEmbed.author ? oldEmbed.author.name : userDisplay, 
                            iconURL: oldEmbed.author ? oldEmbed.author.iconURL : userAvatar 
                        })
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
                    .setColor('#e74c3c') // Pirosas szín a leállításhoz
                    .setAuthor({ 
                        name: oldEmbed.author ? oldEmbed.author.name : userDisplay, 
                        iconURL: oldEmbed.author ? oldEmbed.author.iconURL : userAvatar 
                    })
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
                console.error(error);
                return interaction.editReply({ content: '❌ Nem sikerült betölteni az üzenetet. Biztos, hogy jó ID-t adtál meg?' });
            }
        }
    }
});

client.login(process.env.TOKEN);