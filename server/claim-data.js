require("dotenv").config({ override: true });
const mongoose = require("mongoose");

const [oldId, emailArg] = process.argv.slice(2);
if (!oldId || !emailArg) {
  console.log("Usage: node claim-data.js <oldSessionId> <email>");
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  const db = mongoose.connection.db;

  const user = await db
    .collection("users")
    .findOne({ email: emailArg.trim().toLowerCase() });
  if (!user) {
    console.log("No account with that email. Register first.");
    process.exit(1);
  }

  for (const name of ["messages", "facts", "todos", "reminders"]) {
    const result = await db
      .collection(name)
      .updateMany(
        { sessionId: oldId },
        { $set: { sessionId: String(user._id) } },
      );
    console.log(`${name}: moved ${result.modifiedCount}`);
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
