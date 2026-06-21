import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { tavily } from "@tavily/core";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose"; // 🟢 Added for database

dotenv.config();

const app = express();

// 🟢 FIXED CORS CONFIGURATION TO ALLOW YOUR LIVE SITE
app.use(cors({
  origin: "https://elli1emazzel1-tech.github.io",
  credentials: true
}));

app.use(express.json());

// 🟢 CONNECT TO MONGO_DB ATLAS
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("🟢 DB connected successfully!"))
  .catch(err => console.log("❌ DB connection error:", err));

// 🟢 CREATE THE USER TEMPLATE (SCHEMA) FOR AUTHENTICATION
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const User = mongoose.model("User", userSchema);

// Global Request Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.url}`);
  next();
});

// Rate Limiter: Max 15 requests per minute per IP address
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 15, 
  message: { reply: "⚠ You are sending messages too fast! Please slow down a bit." },
  standardHeaders: true,
  legacyHeaders: false,
});

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

app.get("/", (req, res) => {
  res.send("AI chatbot is running 🚀");
});

// 🟢 SIGNUP ROUTE (Saves a new user to MongoDB)
app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ reply: "Username already taken" });

    const newUser = new User({ username, password });
    await newUser.save();
    res.status(201).json({ reply: "User registered successfully!" });
  } catch (err) {
    res.status(500).json({ reply: "Error: " + err.message });
  }
});

// 🟢 LOGIN ROUTE (Checks credentials against MongoDB)
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || user.password !== password) {
      return res.status(400).json({ reply: "Invalid username or password" });
    }
    res.status(200).json({ reply: "Login successful!", username: user.username });
  } catch (err) {
    res.status(500).json({ reply: "Error: " + err.message });
  }
});

// AI CHAT ROUTE
app.post("/chat", chatLimiter, async (req, res) => {
  try {
    // 1. Grab the conversation history array and selected agent from the frontend request
    const incomingMessages = req.body.messages || [];
    const agent = req.body.agent || "research";
    const temperature = req.body.temperature || 0.7;

    // 2. Validate that we received a list of messages
    if (!incomingMessages || incomingMessages.length === 0) {
      return res.status(400).json({ reply: "Please provide a valid messages history list." });
    }

    // Get the very last message text sent by the user for our casual and web search checking
    const lastUserMessageItem = [...incomingMessages].reverse().find(m => m.role === "user");
    const lastUserMessageText = lastUserMessageItem ? lastUserMessageItem.content : "";

    // 3. Define the custom agent personas matching your frontend setup
    const agentPrompts = {
      research: `You are a research assistant. Give detailed, factual, well-explained answers. Built by Naitik, a 15-year-old developer. Keep replies warm and conversational — like a smart friend, not a robot. Only mention your creator when explicitly asked.`,
      coding: "You are a senior software engineer. Give clean code, technical explanations, and focused solutions.",
      writer: "You are a professional creative writer. Write clearly, engagingly, and creatively.",
      business: "You are a business strategist and expert. Give structured, highly analytical answers.",
      document: "You are an analytical assistant. Review text, data arrays, and document content carefully."
    };

    const systemPrompt = agentPrompts[agent] || agentPrompts.research;

    // 4. Trigger the Tavily Web Search tool if the agent is 'research' and it's not a casual greeting
    const casualWords = ["hi", "hello", "hey", "sup", "yo", "thanks", "ok", "okay"];
    const isCasual = casualWords.some(w => lastUserMessageText.toLowerCase().includes(w));
    
    let webContext = "";
    if (agent === "research" && lastUserMessageText && !isCasual) {
      try {
        const searchResults = await tavilyClient.search(lastUserMessageText, { maxResults: 2 });
        webContext = searchResults.results.map(r => `${r.title}: ${r.content}`).join("\n");
      } catch (searchErr) {
        console.error(`[Error] Tavily API failed: ${searchErr.message}`);
      }
    }

    // 5. If we have web context information, append it directly into the final payload sequence safely
    let structuredHistory = [...incomingMessages];
    if (webContext && lastUserMessageItem) {
      // Enhance the last user prompt item inside our local payload with search facts
      structuredHistory[structuredHistory.length - 1] = {
        role: "user",
        content: `Here is some recent web info:\n${webContext}\n\nUser question: ${lastUserMessageText}`
      };
    }

    // 6. Assemble the final complete execution package combining system instruction + dialogue log
    const completeMessagesPayload = [
      { role: "system", content: systemPrompt },
      ...structuredHistory
    ];

    // 7. Fire it off to the Groq Llama-3 cluster
    const response = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      temperature: Number(temperature),
      messages: completeMessagesPayload,
    });

    const aiReply = response.choices[0].message.content;
    res.json({ reply: aiReply });

  } catch (err) {
    console.error(`[Fatal Server Error] Message routing lifecycle crashed: ${err.message}`);
    res.status(500).json({ reply: "⚠ internal engine error: " + err.message });
  }
});

// Reset endpoint for frontend UI to invoke explicitly
app.post("/chat/clear", (req, res) => {
  res.json({ success: true, status: "Memory context cleared." });
});

app.listen(3000, () => {
  console.log("Server running smoothly on http://localhost:3000");
});
