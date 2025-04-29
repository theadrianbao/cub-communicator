# Cub Communicator: Private Messaging

A simple, end-to-end encrypted chat application for private messaging between users.

<video src="./demo.mp4" controls width="800" style="border-radius: 8px; margin-top: 1rem;"></video>

---

## Getting Started

### Requirements
- [Docker](https://www.docker.com/products/docker-desktop) (with Docker Compose)
- [Node.js](https://nodejs.org/)

---

### Setup Instructions

1. **Set environment variables**  
   Create a `.env` file in `src/server` with:

   ```env
   DATABASE_URL=postgresql://yourusername:yourpassword@localhost:5432/chats
   JWT_SECRET=your_jwt_secret
   POSTGRES_USER=yourusername
   POSTGRES_PASSWORD=yourpassword
   POSTGRES_DB=chats
   ```

2. **Start PostgreSQL database**

   ```bash
   docker compose -f src/server/postgresql.yml up -d
   ```

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Run the application**

   ```bash
   npm start
   ```

Open [http://localhost:3000](http://localhost:3000) to use the app.

---

## Features

- End-to-end encrypted messaging (Sodium cryptography)
- User-to-user chats (Socket.IO, JWT, PostgreSQL)
- Dockerized backend and database
- Message previews and timestamps
- React and Next.js frontend

### Planned Features

- File attachments (Multer)
- Group chats (Socket.IO rooms)
- Image messaging (LocalStorage)
- Kubernetes scaling and Helm support

---

## License

MIT License © 2025
