// Import necessary libraries
const Discord = require('discord.js');
require('dotenv').config(); // Load environment variables from .env file

// Create a new Discord client
const client = new Discord.Client();

/**
 * Event listener for when the bot is ready
 * Provides feedback in the console upon successful login
 */
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

/**
 * Log in to Discord with bot token
 * Utilizes the bot token stored in the .env file for authentication
 */
client.login(process.env.DISCORD_BOT_TOKEN);
