# Backend Setup

> **Note:** You must have Docker installed and configured on your system to run Redis and RabbitMQ using the instructions below.


## Docker Installation

Follow the official Docker installation guide for your operating system:

- **Windows & macOS:**
  - Download Docker Desktop from https://www.docker.com/products/docker-desktop/
  - Run the installer and follow the setup instructions.
  - After installation, launch Docker Desktop and ensure it is running.

- **Linux:**
  - Follow the instructions for your distribution at https://docs.docker.com/engine/install/
  - After installation, start the Docker service:
    ```sh
    sudo systemctl start docker
    ```
  - (Optional) Add your user to the `docker` group to run Docker without `sudo`:
    ```sh
    sudo usermod -aG docker $USER
    # Then log out and log back in
    ```

- To verify Docker is installed and running:
  ```sh
  docker --version
  docker run hello-world
  ```

## Prerequisites
- Docker and Docker Compose installed
- Node.js and npm installed

## 1. Start Redis and RabbitMQ using Docker

You can quickly spin up Redis and RabbitMQ using Docker with the following commands:

### Start Redis
```sh
docker run -d --name redis-server -p 6379:6379 redis
```

### Start RabbitMQ (with management UI)
```sh
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```
- RabbitMQ management UI will be available at: http://localhost:15672 (default user/pass: guest/guest)

## 2. Install Dependencies
```sh
npm install
```

## 3. Configure Environment Variables
Create a `.env` file in the backend directory. Example:
```env
PORT=3000
WS_PORT=3001
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
RABBITMQ_URL=amqp://localhost
MONGODB_URI=mongodb://localhost:27017/your_db
UPLOAD_DIR=uploads
```

## 4. Run the Server
```sh
npm start
```

The backend server will start and connect to Redis and RabbitMQ running in Docker containers.
