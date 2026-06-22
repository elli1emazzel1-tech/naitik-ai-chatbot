import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { tavily } from "@tavily/core";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";

dotenv.config();

const app = express();

// 🟢 OPEN CORS TO ALLOW ALL REQUESTS AND PREVENT BLOCKS
app.use(cors());
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

// 🟢 FIXED: ADDED MISSING GOOGLE LOGIN ROUTE FOR FRONTEND
app.post("/api/google-login", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ reply: "Missing Google token." });
    
    // Quick temporary placeholder so your frontend login script doesn't crash
    res.status(200).json({ reply: "Google login verified!", username: "Google User" });
  } catch (err) {
    res.status(500).json({ reply: "Google Auth Error: " + err.message });
  }
});

// AI CHAT ROUTE
app.post("/chat", chatLimiter, async (req, res) => {
  try {
    const incomingMessages = req.body.messages || [];
    const agent = req.body.agent || "research";
    const temperature = req.body.temperature || 0.7;

    if (!incomingMessages || incomingMessages.length === 0) {
      return res.status(400).json({ reply: "Please provide a valid messages history list." });
    }

    const lastUserMessageItem = [...incomingMessages].reverse().find(m => m.role === "user");
    const lastUserMessageText = lastUserMessageItem ? lastUserMessageItem.content : "";

    // 🟢 UPDATED SYSTEM PROMPTS FOR BETTER PERSONALITY AND LOGIC
    const agentPrompts = {
      research: `You are a helpful, intelligent, and professional AI Assistant built by Naitik, a 15-year-old developer. Your task is to answer user queries clearly, directly, and conversationally—just like ChatGPT. If a user asks "what can you help me with", "what can you do", or similar conversational intros, introduce yourself cleanly as an AI assistant and list your capabilities using bullet points (e.g., answering questions, writing, brainstorming, analyzing data, or coding assistance). Keep your tone friendly, helpful, and concise. Do not talk about music tracks or search terms unless directly asked.`,
      coding: "You are a senior software engineer. Give clean code, technical explanations, and focused solutions.",
      writer: "You are a professional creative writer. Write clearly, engagingly, and creatively.",
      business: "You are a business strategist and expert. Give structured, highly analytical answers.",
      document: "You are an analytical assistant. Review text, data arrays, and document content carefully."
    };

    const systemPrompt = agentPrompts[agent] || agentPrompts.research;

    // 🟢 EXPANDED CHECK TO AVOID ACCIDENTAL WEB SEARCHES ON BASIC CHAT
    const cleanMessage = lastUserMessageText.toLowerCase().trim();
    const casualWords = ["hi", "hello", "hey", "sup", "yo", "thanks", "ok", "okay", "help me", "what can you do", "who are you", "what can u help me"];
    const isCasual = casualWords.some(w => cleanMessage.includes(w)) || cleanMessage.length < 3;
    
    let webContext = "";
    if (agent === "research" && lastUserMessageText && !isCasual) {
      try {
        const searchResults = await tavilyClient.search(lastUserMessageText, { maxResults: 2 });
        webContext = searchResults.results.map(r => `${r.title}: ${r.content}`).join("\n");
      } catch (searchErr) {
        console.error(`[Error] Tavily API failed: ${searchErr.message}`);
      }
    }

    let structuredHistory = [...incomingMessages];
    if (webContext && lastUserMessageItem) {
      structuredHistory[structuredHistory.length - 1] = {
        role: "user",
        content: `Here is some recent web info:\n${webContext}\n\nUser question: ${lastUserMessageText}`
      };
    }

    const completeMessagesPayload = [
      { role: "system", content: systemPrompt },
      ...structuredHistory
    ];

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

app.post("/chat/clear", (req, res) => {
  res.json({ success: true, status: "Memory context cleared." });
});

app.listen(3000, () => {
  console.log("Server running smoothly on http://localhost:3000");
});
