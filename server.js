const app = require("./app");

const dotenv = require("dotenv");

const mongoose = require("mongoose");

dotenv.config({ path: "./config.env" });

// const path = require("path");

const User = require("./models/user");
const FriendRequest = require("./models/friendRequest");
const OneToOneMessage = require("./models/oneToOneMessage");

const { Server } = require("socket.io");

process.on("uncaughtException", (err) => {
  console.log(err);
  process.exit(1);
});

const http = require("http");
// const OneToOneMessage = require("./models/oneToOneMessage");
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origins: ["http://localhost:3000", "https://chat-app-44f8e.web.app/"],
    method: ["GET", "POST"],
  },
});

const DB = process.env.DBURI.replace("<PASSWORD>", process.env.DBPASSWORD);

mongoose
  .connect(DB, {
    // useNewUrlParser: true,
    // useCreateIndex: true,
    // useFindAndModify: false,
    // useUnifiedTopology: true,
  })
  .then((con) => {
    console.log("DB Connection is Successful");
  })
  .catch((err) => {
    console.log(err);
  });

const port = process.env.PORT || 8000;

server.listen(port, () => {
  console.log(`App running on port ${port}`);
});

io.on("connection", async (socket) => {
  // console.log(JSON.stringify(socket.handshake.query))

  const user_id = socket.handshake.query["user_id"];

  const socket_id = socket.id;

  console.log(`User Connected ${socket_id}`);

  if (Boolean(user_id)) {
    await User.findByIdAndUpdate(user_id, { socket_id, status: "Online" });
  }

  //we can write our socket event listners here..

  socket.on("friend_request", async (data) => {
    console.log(data.to);

    // data => {to, from}

    const to_user = await User.findById(data.to).select("socket_id");
    const from_user = await User.findById(data.from).select("socket_id");

    //Create a friend request

    await FriendRequest.create({
      sender: data.from,
      recipient: data.to,
    });

    //emit event => "new friend request"

    io.to(to_user.socket_id).emit("new_friend_request", {
      //
      message: "New Friend Request Received",
    });

    //emit event => "request_sent"
    io.to(from_user.socket_id).emit("request_sent", {
      message: "Request sent successfully",
    });
  });

  socket.on("accept_request", async (data) => {
    console.log(data);

    const request_doc = await FriendRequest.findById(data.request_id);

    console.log(request_doc);

    //request_id

    const sender = await User.findById(request_doc.sender);
    const receiver = await User.findById(request_doc.recipient);

    if (sender.friends == null) {
      sender.friends = [];
    }

    if (receiver.friends == null) {
      receiver.friends = [];
    }

    sender.friends.push(request_doc.recipient);
    receiver.friends.push(request_doc.sender);

    await receiver.save({ new: true, validateModifiedOnly: true });
    await sender.save({ new: true, validateModifiedOnly: true });

    await FriendRequest.findByIdAndDelete(data.request_id);

    io.to(sender.socket_id).emit("request_accepted", {
      message: "Friend Request Accepted",
    });
    io.to(receiver.socket_id).emit("request_accepted", {
      message: "Friend Request Accepted",
    });
  });

  socket.on("get_direct_conversations", async ({ user_id }, callback) => {
    const existing_conversations = await OneToOneMessage.find({
      participants: { $all: [user_id] },
    }).populate("participants", "firstName lastName _id email status");

    callback(existing_conversations);
  });

  socket.on("start_conversation", async (data) => {
    const { to, from } = data;

    const existing_conversation = await OneToOneMessage.find({
      participants: { $size: 2, $all: [to, from] },
    }).populate("participants", "firstName lastName _id email status");

    console.log(existing_conversation[0], "Existing COnversation");

    if (existing_conversation.length === 0) {
      let new_chat = await OneToOneMessage.create({
        participants: [to, from],
      });

      new_chat = await OneToOneMessage.findById(new_chat._id).populate(
        "participants",
        "firstName lastName _id email status"
      );

      console.log(new_chat);

      socket.emit("start_chat", new_chat);
    } else {
      socket.emit("start_chat", existing_conversation[0]);
    }
  });

  socket.on("get_messages", async (data, callback) => {
    const messages = await OneToOneMessage.findById(
      data.conversation_id
    ).select("messages");
    callback(messages);
  });

  //Handle text/link messages

  socket.on("text_message", async (data) => {
    // console.log("Received message", data);
    //data => {to, from , message, conversation_id, type}
    const { to, from, message, conversation_id, type } = data;

    const to_user = await User.findById(to);
    const from_user = await User.findById(from);

    console.log(to);

    const new_message = {
      to,
      from,
      type,
      text: message,
      created_at: Date.now(),
    };

    //create new conversation if it does not exist yet or add new message to the messages list
    const chat = await OneToOneMessage.findById(conversation_id);
    chat.messages.push(new_message);
    // console.log(chat);
    //save to db
    await chat.save({});
    //emit incoming message -> to user
    io.to(to_user.socket_id).emit({
      conversation_id,
      message: new_message,
    });

    //emit outgoing message -> from user
    io.to(from_user.socket_id).emit({
      conversation_id,
      message: new_message,
    });
  });

  socket.on("file_message", (data) => {
    console.log("Received Message", data);

    //data: {to, from, text, file}

    //get the file extension
    const fileExtension = path.extname(data.file.name);

    //generate a unique filename
    const fileName = `${Date.now()}_${Math.floor(
      Math.random() * 10000
    )}${fileExtension}`;

    //upload file to AWS S3

    //create new conversation if it does not exist yet or add new message to the messages list

    //save to db

    //emit incoming message -> to user

    //emit outgoing message -> from user
  });

  socket.on("end", async (data) => {
    //Find user by _id and then set status to offline
    if (data.user_id) {
      await User.findByIdAndUpdate(data.user_id, { status: "Offline" });
    }

    //TODO broadcast user disconnected

    console.log("Closing connection");
    socket.disconnect(0);
  });
});

process.on("unhandledRejection", (err) => {
  console.log(err);
  server.close(() => {
    process.exit(1);
  });
});
