
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

// Import document routes
const documentRoutes = require("./routes/documents");

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected successfully!");
  })
  .catch((error) => {
    console.error("MongoDB connection error:", error.message);
  });

// Allow requests from the React frontend
app.use(cors());

// Allow the backend to read JSON data
app.use(express.json());

// Connect document API routes
// This enables /api/documents/:id/file
app.use("/api/documents", documentRoutes);

app.get("/test-server", (req, res) => {
  res.send("SERVER.JS IS UPDATED");
});
// Main test route
app.get("/", (req, res) => {
  res.json({
    message: "Document Verification API is running!",
    status: "success",
  });
});

// Backend health-check route
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Backend is healthy",
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
