import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  TextChannel
} from "discord.js";
import dotenv from "dotenv";

dotenv.config();

// ============================================================
// Configuration & Environment Variables
// ============================================================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const API_KEY = process.env.MY_MC_API_KEY;
const SERVER_ID = process.env.SERVER_ID || "Minecraft";
// Fixed type mismatch: Keep CMD_CHANNEL_ID as a string to match interaction.channelId safely
const CMD_CHANNEL_ID = process.env.CMD_CHANNEL_ID || "";
const CMD_CHANNEL_NAME = process.env.CMD_CHANNEL_NAME || "〢💻⪼『-ᴄᴏᴍᴍᴀɴᴅ÷ʟɪɴᴇ』";
const BASE_URL = (process.env.MY_MC_API_BASE || "https://api.my-mc.link").replace(/\/$/, "");
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || "1.21.11";
const JAVA_ADDRESS_FALLBACK = process.env.JAVA_ADDRESS_FALLBACK || "my-mc.link:40891";
const BAO_SERVER_IP = process.env.BAO_SERVER_IP || "rcesc.playwithbao.com";

let javaLinkCache: string | null = null;
let javaLinkCacheTime = 0;
const JAVA_LINK_TTL = 600000; // 10 minutes in ms

// ============================================================
// Helper Functions: API Requests & Truncation
// ============================================================
function truncate(text: string | null, limit = 300): string {
  if (!text) return "";
  return text.length <= limit ? text : text.substring(0, limit) + "…";
}

async function apiRequest(endpoint: string, method = "GET", body: any = null): Promise<[boolean, any, string | null]> {
  if (!API_KEY || API_KEY === "YOUR_MY_MC_API_KEY") {
    return [false, null, "The My-MC.Link API key is missing."];
  }

  const url = `${BASE_URL}/${endpoint.replace(/^\//, "")}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-my-mc-auth": API_KEY,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const raw = await response.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const msg = data?.message || data?.error || raw || "No response.";
      return [false, data, `API returned HTTP ${response.status}:${truncate(String(msg))}`];
    }

    if (!data) return [false, null, "Invalid response from API."];
    if (data.success !== true && endpoint !== "/stats" && !endpoint.startsWith("status/")) {
      return [false, data, String(data.message || "Request rejected by API.")];
    }

    return [true, data, null];
  } catch (err: any) {
    return [false, null, `Could not connect to the API: ${truncate(err.message)}`];
  }
}

async function getMyMcStatus(): Promise<[boolean | null, any, string | null]> {
  const [success, data, error] = await apiRequest(`/status/${SERVER_ID}`);
  if (!success) {
    if (error && error.includes("HTTP 404")) return [false, null, null];
    return [null, data, error];
  }
  const isOnline = data?.status?.isOnline;
  if (typeof isOnline !== "boolean") return [null, data, "Invalid status format from API."];
  return [isOnline, data, null];
}

async function getBaoServerStatus(): Promise<any> {
  try {
    const res = await fetch(`https://api.mcsrvstat.us/3/${BAO_SERVER_IP}`);
    return await res.json();
  } catch {
    return { online: false };
  }
}

async function getJavaAddress(): Promise<string> {
  const now = Date.now();
  if (javaLinkCache && now - javaLinkCacheTime < JAVA_LINK_TTL) {
    return javaLinkCache;
  }

  const [success, data] = await apiRequest("/my-link");
  if (success && data?.hostname && data?.port) {
    javaLinkCache = `${data.hostname}:${data.port}`;
    javaLinkCacheTime = now;
    return javaLinkCache;
  }

  return javaLinkCache || JAVA_ADDRESS_FALLBACK;
}

// ============================================================
// Bot Client Setup
// ============================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const commands = [
  new SlashCommandBuilder().setName("status").setDescription("Displays modern status for both My-MC and Bao Host servers."),
  new SlashCommandBuilder().setName("start").setDescription("Starts the My-MC Minecraft server."),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stops the My-MC Minecraft server. (Admins only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("restart").setDescription("Restarts the My-MC Minecraft server."),
  new SlashCommandBuilder().setName("my-mc-link").setDescription("Retrieves the My-MC Java connection link."),
  new SlashCommandBuilder().setName("serverhelp").setDescription("Displays available server-management commands."),
  new SlashCommandBuilder()
    .setName("api-debug")
    .setDescription("Probes API endpoints. (Admins only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}!`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN!);
  try {
    await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
    console.log("Successfully registered global slash commands.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
});

// ============================================================
// Interaction & Channel Guard Handling
// ============================================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Channel restriction guard (comparing strings safely)
  if (interaction.guildId && CMD_CHANNEL_ID && interaction.channelId !== CMD_CHANNEL_ID) {
    await interaction.reply({
      content: `❌ Please use commands in <#${CMD_CHANNEL_ID}>.`,
      ephemeral: true,
    });
    return;
  }

  const { commandName } = interaction;

  try {
    if (commandName === "status") {
      await interaction.deferReply();

      // Fetch My-MC & Bao Host in parallel
      const [myMcOnline, myMcData, myMcError] = await getMyMcStatus();
      const [statsOk, statsData] = await apiRequest("stats");
      const javaAddress = await getJavaAddress();
      const baoData = await getBaoServerStatus();

      const embed = new EmbedBuilder()
        .setTitle("🌐 Minecraft Servers Status Hub")
        .setColor(myMcOnline ? 0x57F287 : 0xED4245)
        .setTimestamp();

      // My-MC Section
      if (myMcOnline === null) {
        embed.addFields({ name: "🟢 My-MC Server", value: `❌ Status check failed: \`${myMcError}\`` });
      } else if (!myMcOnline) {
        embed.addFields({ name: "🔴 My-MC Server", value: "Offline / Stopped" });
      } else {
        const players = myMcData?.status?.data?.players || { online: 0, max: 0 };
        let statsInfo = "";
        if (statsOk && statsData?.stats) {
          const mem = statsData.stats.memory;
          statsInfo = `\nCPU: \`${statsData.stats.cpu || "N/A"}\` | RAM: \`${mem?.raw || "N/A"} (${mem?.percent || "0%"})\``;
        }
        embed.addFields({
          name: "🟢 My-MC Server (Online)",
          value: `👥 Players: \`${players.online} / ${players.max}\`\n☕ Java IP: \`${javaAddress}\`${statsInfo}`,
        });
      }

      // Bao Host Section
      if (baoData && baoData.online) {
        const baoPlayers = baoData.players || { online: 0, max: 0 };
        embed.addFields({
          name: "🟢 Bao Host Server (`rcesc.playwithbao.com`)",
          value: `👥 Players: \`${baoPlayers.online} / ${baoPlayers.max}\`\n📌 Version: \`${baoData.version || "Unknown"}\``,
        });
      } else {
        embed.addFields({
          name: "🔴 Bao Host Server (`rcesc.playwithbao.com`)",
          value: "Currently offline or unreachable.",
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } 
    else if (commandName === "start") {
      await interaction.deferReply();
      const [isOnline] = await getMyMcStatus();
      if (isOnline) {
        await interaction.editReply("✅ The server is **already online**!");
        return;
      }
      const [success, data, error] = await apiRequest("start", "GET");
      if (success) {
        await interaction.editReply("🚀 **Server start command sent!** Check `/status` in a few minutes.");
      } else {
        await interaction.editReply(`❌ **Failed to start:** \`${error || data?.message}\``);
      }
    } 
    else if (commandName === "stop") {
      await interaction.deferReply();
      const [success, data, error] = await apiRequest("stop", "GET");
      if (success) {
        await interaction.editReply("🛑 **Server stop command sent!** Shutting down...");
      } else {
        await interaction.editReply(`❌ **Failed to stop:** \`${error || data?.message}\``);
      }
    } 
    else if (commandName === "restart") {
      await interaction.deferReply();
      const [success, data, error] = await apiRequest("restart", "GET");
      if (success) {
        await interaction.editReply("🔄 **Server restart command sent!** Booting up...");
      } else {
        await interaction.editReply(`❌ **Failed to restart:** \`${error || data?.message}\``);
      }
    } 
    else if (commandName === "my-mc-link") {
      await interaction.deferReply();
      const [success, data, error] = await apiRequest("my-link");
      if (!success) {
        await interaction.editReply(`❌ Failed to retrieve the network link.\n\`${error}\``);
        return;
      }
      const hostname = data.hostname || "Unknown";
      const port = data.port || "Unknown";
      javaLinkCache = `${hostname}:${port}`;
      javaLinkCacheTime = Date.now();

      const embed = new EmbedBuilder()
        .setTitle("🌐 My-MC Java Network Link")
        .setDescription(`**Address:** \`${hostname}:${port}\``)
        .setColor(0x5865F2);

      await interaction.editReply({ embeds: [embed] });
    } 
    else if (commandName === "serverhelp") {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🛠️ Minecraft Server Management")
            .setDescription("Commands available to control and view your servers:")
            .addFields(
              { name: "/status", value: "Shows live player stats and usage for both My-MC and Bao Host." },
              { name: "/start", value: "Boots up the My-MC server." },
              { name: "/stop", value: "Safely shuts down My-MC (Admin only)." },
              { name: "/restart", value: "Restarts My-MC container." },
              { name: "/my-mc-link", value: "Retrieves the direct My-MC Java connection address." }
            )
            .setColor(0x3498DB),
        ],
      });
    }
    else if (commandName === "api-debug") {
      await interaction.deferReply({ ephemeral: true });
      const probes = [`status/${SERVER_ID}`, "stats", "my-link"];
      let resultReport = "";
      for (const endpoint of probes) {
        const [ok, , err] = await apiRequest(endpoint);
        resultReport += `${ok ? "✅" : "❌"} GET /${endpoint} →${ok ? "OK" : truncate(err, 60)}\n`;
      }
      await interaction.editReply(`\`\`\`\n${resultReport}\n\`\`\``);
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    const errPayload = { content: "❌ Something went wrong while running that command.", ephemeral: true };
    if (interaction.deferred) {
      await interaction.editReply(errPayload);
    } else if (!interaction.replied) {
      await interaction.reply(errPayload);
    }
  }
});

// ============================================================
// Start Bot
// ============================================================
if (!DISCORD_TOKEN || !API_KEY) {
  console.error("Missing DISCORD_TOKEN or MY_MC_API_KEY in environment variables.");
} else {
  client.login(DISCORD_TOKEN);
}
