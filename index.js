const { Client, GatewayIntentBits, Partials, WebhookClient, InteractionResponseType, SlashCommandBuilder } = require('discord.js');
const mongoose = require('mongoose');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const { TOKEN, MONGODB_URI, WEBHOOK1_ID, WEBHOOK1_TOKEN, WEBHOOK2_ID, WEBHOOK2_TOKEN } = process.env;

mongoose.connect(MONGODB_URI, { useUnifiedTopology: true, useNewUrlParser: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Error connecting to MongoDB:', err));

const RepostedMessage = mongoose.model('RepostedMessage', new mongoose.Schema({
    guildName: String,
    guildId: String,
    star: {
        originalMessageID: String,
        starboardMessageID: String,
        timestamp: Date,
    }
}));

const GuildSettings = mongoose.model('GuildSettings', new mongoose.Schema({
    guildName: String,
    guildId: String,
    star: {
        whitelistChannelIds: [String],
        starboardChannelIds: [String],
        starLevels: [{
            level: Number,
            minReactions: Number,
        }],
    },
}));

const lock = new Map();
const webhookConfigs = [
    { id: WEBHOOK1_ID, token: WEBHOOK1_TOKEN },
    { id: WEBHOOK2_ID, token: WEBHOOK2_TOKEN },
];

client.on('ready', () => {
    client.guilds.cache.forEach(guild => {
        guild.commands.set([
            new SlashCommandBuilder()
                .setName('ping')
                .setDescription('Replies with Pong!'),
            new SlashCommandBuilder()
                .setName('star')
                .setDescription('Configure starboard levels')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('whitelist')
                        .setDescription('Add or remove channels from the whitelist')
                        .addChannelOption(option =>
                            option.setName('add')
                                .setDescription('Add a channel to the whitelist')
                                .setRequired(false))
                        .addChannelOption(option =>
                            option.setName('remove')
                                .setDescription('Remove a channel from the whitelist')
                                .setRequired(false))
                        .addChannelOption(option =>
                            option.setName('set')
                                .setDescription('Set a channel to the starboard')
                                .setRequired(false)))
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('repost')
                        .setDescription('Set starboard level')
                        .addIntegerOption(option =>
                            option.setName('level')
                                .setDescription('Starboard level (1, 2, or 3)')
                                .setRequired(true))
                        .addIntegerOption(option =>
                            option.setName('count')
                                .setDescription('count reactions required')
                                .setRequired(true))),
        ]);
    });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'ping') {
        const botLatency = Date.now() - interaction.createdTimestamp;
        await interaction.reply({
            content: `🏓 Pong! Latency: ${botLatency}ms`,
            ephemeral: false,
        });
    } else if (commandName === 'star') {
        const subcommand = options.getSubcommand();
        const guildId = interaction.guild.id;
        const guildName = interaction.guild.name;

        try {
            switch (subcommand) {
                case 'repost':
                    const level = options.getInteger('level');
                    const minReactions = options.getInteger('count');
                    await handleStarboardConfiguration(interaction, guildId, guildName, level, minReactions);
                    break;

                case 'whitelist':
                    await handleWhitelistOperation(interaction, guildId, guildName, options);
                    break;

                default:
                    break;
            }
        } catch (error) {
            console.error('Error handling interaction:', error);
            await interaction.reply({
                content: 'Error handling interaction',
                ephemeral: false,
            });
        }
    }
});

async function handleStarboardConfiguration(interaction, guildId, guildName, level, minReactions) {
    const guildSettings = await getGuildSettings(guildId, guildName);

    if (!guildSettings) {
        return interaction.reply({
            content: 'Guild settings not found. Please set up your guild settings first.',
            ephemeral: true,
        });
    }

    const existingLevelIndex = guildSettings.star.starLevels.findIndex(
        (starLevel) => starLevel.level === level
    );

    if (existingLevelIndex !== -1) {
        guildSettings.star.starLevels[existingLevelIndex].minReactions = minReactions;
    } else {
        guildSettings.star.starLevels.push({ level, minReactions });
    }

    await guildSettings.save();
    await interaction.reply({
        content: `Starboard level ${level} configured with ${minReactions} reactions`,
        ephemeral: false,
    });
}

async function handleWhitelistOperation(interaction, guildId, guildName, options) {
    const addChannelOption = options.getChannel('add');
    const removeChannelOption = options.getChannel('remove');
    const setChannelOption = options.getChannel('set');

    if (!addChannelOption && !removeChannelOption && !setChannelOption) {
        return interaction.reply({
            content: 'Please provide a channel to add, remove, or set in the whitelist.',
            ephemeral: false,
        });
    }

    let channelId;
    let action;

    if (addChannelOption) {
        channelId = addChannelOption.id;
        action = 'add';
    } else if (removeChannelOption) {
        channelId = removeChannelOption.id;
        action = 'remove';
    } else if (setChannelOption) {
        channelId = setChannelOption.id;
        action = 'set';
    }

    switch (action) {
        case 'add':
            await handleWhitelistAdd(interaction, guildId, channelId, guildName);
            break;
        case 'remove':
            await handleWhitelistRemove(interaction, guildId, channelId, guildName);
            break;
        case 'set':
            await handleWhitelistSet(interaction, guildId, channelId, guildName);
            break;
        default:
            break;
    }
}

async function handleWhitelistAdd(interaction, guildId, channelId, guildName) {
    try {
        await GuildSettings.findOneAndUpdate(
            { guildId },
            { $addToSet: { 'star.whitelistChannelIds': channelId }, guildName },
            { upsert: true }
        );
        await interaction.reply({
            content: `Whitelist channel added: <#${channelId}>`,
            ephemeral: false,
        });
    } catch (error) {
        console.error('Error adding whitelist channel:', error);
        await interaction.reply({
            content: 'Error adding whitelist channel',
            ephemeral: false,
        });
    }
}

async function handleWhitelistRemove(interaction, guildId, channelId, guildName) {
    try {
        await GuildSettings.findOneAndUpdate(
            { guildId },
            { $pull: { 'star.whitelistChannelIds': channelId } },
            { upsert: true }
        );
        await interaction.reply({
            content: `Whitelist channel removed: <#${channelId}>`,
            ephemeral: false,
        });
    } catch (error) {
        console.error('Error removing whitelist channel:', error);
        await interaction.reply({
            content: 'Error removing whitelist channel',
            ephemeral: false,
        });
    }
}

async function handleWhitelistSet(interaction, guildId, channelId, guildName) {
    try {
        await GuildSettings.findOneAndUpdate(
            { guildId },
            { $addToSet: { 'star.starboardChannelIds': channelId }, guildName },
            { upsert: true }
        );
        await interaction.reply({
            content: `Starboard channel set: <#${channelId}>`,
            ephemeral: false,
        });
    } catch (error) {
        console.error('Error setting starboard channel:', error);
        await interaction.reply({
            content: 'Error setting starboard channel',
            ephemeral: false,
        });
    }
}

async function getGuildSettings(guildId, guildName) {
    try {
        let guildSettings = await GuildSettings.findOne({ guildId });

        if (!guildSettings) {
            guildSettings = new GuildSettings({
                guildId,
                guildName,
                star: {
                    starboardChannelIds: '',
                    starLevels: [],
                    whitelistChannelIds: [],
                },
            });
        }

        return guildSettings;
    } catch (error) {
        console.error('Error getting guild settings:', error);
        return null;
    }
}

client.on('messageReactionAdd', async (reaction, user) => {
    const guildId = reaction.message.guild.id;
    const guildSettings = await GuildSettings.findOne({ guildId });

    if (guildSettings && guildSettings.star.whitelistChannelIds.includes(reaction.message.channel.id)) {
        await checkReactions(reaction.message, guildSettings);
    }
});
async function checkReactions(message, guildSettings) {
    const starboardChannelIds = guildSettings.star.starboardChannelIds;

    if (!starboardChannelIds.includes(message.channel.id)) {
        console.error('Starboard channel not found. Cannot repost.');
        return;
    }

    if (lock.has(message.id)) {
        return;
    }

    lock.set(message.id, true);

    try {
        const fetchedMessage = await message.fetch(true);
        const reactions = fetchedMessage.reactions.cache;
        const totalReactions = reactions.reduce((acc, reaction) => acc + reaction.count, 0);
        const starLevels = guildSettings.star.starLevels;

        const levelCriteria = starLevels.find(level => totalReactions === level.minReactions);

        if (!levelCriteria) {
            console.log('Message in whitelist channel does not meet reaction count criteria. Not reposting.');
            return;
        }

        const currentWebhookConfig = webhookConfigs[currentWebhookIndex];
        const webhookClient = new WebhookClient(currentWebhookConfig);
        const title = getStarboardTitle(levelCriteria.level);
        const serverAndChannelInfo = `<#${message.channel.id}>`;
        const userAvatarURL = message.author.displayAvatarURL({ format: 'png', dynamic: true, size: 128 });
        const starboardMessageContent = `${serverAndChannelInfo} | **${title} ` +
            `${message.author.globalName ? `${message.author.globalName}` : ''}** \`(${message.author.tag})\`` +
            `${message.content ? `\n${message.content}` : ''}\n - **การตอบรับที่ได้รับ**:\n${reactions.map(reaction => `${reaction.emoji} **${reaction.count}**`).join(' ㅤ ')}`;

        const starboardMessage = await webhookClient.send({
            content: starboardMessageContent,
            files: fetchedMessage.attachments.map(attachment => attachment.url),
            username: message.author.globalName ? message.author.globalName : message.author.tag,
            avatarURL: userAvatarURL,
        });

        await saveRepostedMessage(guildSettings.guildName, message.id, starboardMessage.id);
        currentWebhookIndex = (currentWebhookIndex + 1) % webhookConfigs.length;
    } catch (error) {
        console.error(`Error reposting message: ${error}`);
    } finally {
        lock.delete(message.id);
    }
}

function getStarboardTitle(level) {
    switch (level) {
        case 1:
            return ':sparkles: โพสต์ที่น่าสนใจจาก';
        case 2:
            return ':star: โพสต์ที่น่าสนใจมากจาก';
        case 3:
            return ':fire: โพสต์นี้กำลังไหม้จาก';
        default:
            return '';
    }
}

async function saveRepostedMessage(guildName, originalMessageID, starboardMessageID) {
    try {
        await RepostedMessage.create({
            guildName,
            star: {
                originalMessageID,
                starboardMessageID,
                timestamp: new Date(),
            }
        });
        console.log('Reposted message saved to MongoDB');
    } catch (error) {
        console.error('Error saving reposted message to MongoDB:', error);
    }
}

client.login(TOKEN);
