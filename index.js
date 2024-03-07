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

const TOKEN = process.env.TOKEN;
const STARBOARD_CHANNEL_ID = process.env.STARBOARD_CHANNEL_ID;

// Update the MongoDB URI from your .env file
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI, { useUnifiedTopology: true, useNewUrlParser: true })
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Error connecting to MongoDB:', err));

// Schema for RepostedMessage
const RepostedMessageSchema = new mongoose.Schema({
    guildName: String,
    guildId: String,
    star: {
        originalMessageID: String,
        starboardMessageID: String,
        timestamp: Date,
    }
});

// Model for RepostedMessage
const RepostedMessage = mongoose.model('RepostedMessage', RepostedMessageSchema);

// Schema for GuildSettings
const GuildSettingsSchema = new mongoose.Schema({
    guildName: String,
    guildId: String,
    star: {
        whitelistChannelIds: [String],
        starLevels: [{
            level: Number,
            minReactions: Number,
        }],
    },
});

// Model for GuildSettings
const GuildSettings = mongoose.model('GuildSettings', GuildSettingsSchema);

const lock = new Map();

// Register slash commands
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
                            option.setName('list')
                                .setDescription('Get the list of channels in the whitelist')
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
        // Ping command
        const botLatency = Date.now() - interaction.createdTimestamp;

        await interaction.reply({
            content: `🏓 Pong! Latency: ${botLatency}ms`,
            ephemeral: false,
        });
    } else if (commandName === 'star') {
        // Star command
        const subcommand = options.getSubcommand();
        const guildId = interaction.guild.id;
        const guildName = interaction.guild.name;

        try {
            let level;
            let minReactions;

            switch (subcommand) {
                case 'repost':
                    // Configure starboard level
                    level = options.getInteger('level');
                    minReactions = options.getInteger('count');
                    break;

                case 'whitelist':
                    // Whitelist channel add/remove
                    const addChannelOption = options.getChannel('add');
                    const removeChannelOption = options.getChannel('remove');
                    const listChannelOption = options.getChannel('list');

                    if (listChannelOption) {
                        await handleListWhitelist(interaction, guildId, guildName);
                        return;
                    }

                    if (!addChannelOption && !removeChannelOption) {
                        return interaction.reply({
                            content: 'Please provide a channel to add or remove from the whitelist.',
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
                    }

                    switch (action) {
                        case 'add':
                            await handleAddWhitelist(interaction, guildId, channelId, guildName);
                            break;
                        case 'remove':
                            await handleRemoveWhitelist(interaction, guildId, channelId, guildName);
                            break;
                        default:
                            break;
                    }
                    return;

                default:
                    return;
            }

            // Fetch guild settings from the database
            const guildSettings = await GuildSettings.findOne({
                guildId
            });

            if (!guildSettings) {
                console.error(`Guild settings not found for guild ID: ${guildId}`);
                return interaction.reply({
                    content: 'Guild settings not found. Please make sure to set up your guild settings first.',
                    ephemeral: true,
                });
            }

            // Check if the level already exists in the array
            const existingLevelIndex = guildSettings.star.starLevels.findIndex(
                (starLevel) => starLevel.level === level
            );

            if (existingLevelIndex !== -1) {
                // Update the existing entry
                guildSettings.star.starLevels[existingLevelIndex].minReactions = minReactions;
            } else {
                // Add a new entry
                guildSettings.star.starLevels.push({
                    level,
                    minReactions,
                });
            }

            // Save the updated data to the database
            await guildSettings.save();

            await interaction.reply({
                content: `Starboard level ${level} configured with ${minReactions} reactions`,
                ephemeral: false,
            });
        } catch (error) {
            console.error('Error configuring starboard level:', error);
            await interaction.reply({
                content: 'Error configuring starboard level',
                ephemeral: false,
            });
        }
    }
});

async function handleListWhitelist(interaction, guildId, guildName) {
    try {
        const guildSettings = await GuildSettings.findOne({ guildId });

        if (!guildSettings) {
            console.error(`Guild settings not found for guild ID: ${guildId}`);
            return interaction.reply({
                content: 'Guild settings not found. Please make sure to set up your guild settings first.',
                ephemeral: true,
            });
        }

        const whitelistChannels = guildSettings.star.whitelistChannelIds;
        const formattedChannels = whitelistChannels.map(channelId => `<#${channelId}>`).join(', ');

        await interaction.reply({
            content: `Whitelist channels: ${formattedChannels}`,
            ephemeral: false,
        });
    } catch (error) {
        console.error('Error listing whitelist channels:', error);
        await interaction.reply({
            content: 'Error listing whitelist channels',
            ephemeral: false,
        });
    }
}

async function handleAddWhitelist(interaction, guildId, channelId, guildName) {
    try {
        // Update the document to push the new channelId to the whitelistChannels array
        const channelOption = interaction.options.getChannel('add');

        if (!channelOption) {
            return interaction.reply({
                content: 'Please provide a channel to add to the whitelist.',
                ephemeral: true,
            });
        }

        const addedChannelId = channelOption.id;

        await GuildSettings.findOneAndUpdate(
            { guildId },
            { $addToSet: { 'star.whitelistChannelIds': addedChannelId }, guildName },
            { upsert: true }
        );

        await interaction.reply({
            content: `Whitelist channel added: <#${addedChannelId}>`,
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

async function handleRemoveWhitelist(interaction, guildId, channelId, guildName) {
    try {
        // Update the document to pull the channelId from the whitelistChannels array
        const channelOption = interaction.options.getChannel('remove');

        if (!channelOption) {
            return interaction.reply({
                content: 'Please provide a channel to remove from the whitelist.',
                ephemeral: true,
            });
        }

        const removedChannelId = channelOption.id;

        await GuildSettings.findOneAndUpdate(
            { guildId },
            { $pull: { 'star.whitelistChannelIds': removedChannelId } },
            { upsert: true }
        );

        await interaction.reply({
            content: `Whitelist channel removed: <#${removedChannelId}>`,
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

client.on('messageReactionAdd', async (reaction, user) => {
    const guildId = reaction.message.guild.id;
    const guildSettings = await GuildSettings.findOne({
        guildId
    });

    if (guildSettings && guildSettings.star.whitelistChannelIds.includes(reaction.message.channel.id)) {
        await checkReactions(reaction.message, guildSettings);
    }
});

let currentWebhookIndex = 0;
const webhookConfigs = [{
        id: process.env.WEBHOOK1_ID,
        token: process.env.WEBHOOK1_TOKEN
    },
    {
        id: process.env.WEBHOOK2_ID,
        token: process.env.WEBHOOK2_TOKEN
    },
    // Add more webhook configurations if needed
];

async function checkReactions(message, guildSettings) {
    const guildId = message.guild.id;

    try {
        const starboardChannel = client.channels.cache.get(STARBOARD_CHANNEL_ID);

        if (!starboardChannel) {
            console.error(`Starboard channel not found. Cannot repost.`);
            return;
        }

        if (lock.has(message.id)) {
            return;
        }

        lock.set(message.id, true);

        const fetchedMessage = await message.fetch(true);
        const reactions = fetchedMessage.reactions.cache;
        const totalReactions = reactions.reduce((acc, reaction) => acc + reaction.count, 0);

        // Check if the totalReactions meets the criteria for any starboard level
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
        const userAvatarURL = message.author.displayAvatarURL({
            format: 'png',
            dynamic: true,
            size: 128
        });
        const starboardMessageContent = `${serverAndChannelInfo} | **${title} ` + `${message.author.globalName ? `${message.author.globalName}` : ''}** \`(${message.author.tag})\`` + `${message.content ? `\n${message.content}` : ''}\n - **การตอบรับที่ได้รับ**:\n${reactions.map(reaction => `${reaction.emoji} **${reaction.count}**`).join(' ㅤ ')}`;

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
