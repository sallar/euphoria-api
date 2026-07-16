import type { NotificationServerEvent } from "@/models/notification";

type NotificationSocket = {
  id: string;
  send: (event: NotificationServerEvent) => unknown;
};

class NotificationSocketHub {
  private readonly socketsByUserId = new Map<string, Map<string, NotificationSocket>>();

  add(userId: string, socket: NotificationSocket) {
    const sockets = this.socketsByUserId.get(userId) ?? new Map<string, NotificationSocket>();
    sockets.set(socket.id, socket);
    this.socketsByUserId.set(userId, sockets);
  }

  remove(userId: string, socketId: string) {
    const sockets = this.socketsByUserId.get(userId);
    if (!sockets) return;

    sockets.delete(socketId);
    if (sockets.size === 0) this.socketsByUserId.delete(userId);
  }

  sendToUser(userId: string, event: NotificationServerEvent) {
    const sockets = this.socketsByUserId.get(userId);
    if (!sockets) return 0;

    let sent = 0;
    for (const [socketId, socket] of sockets) {
      try {
        socket.send(event);
        sent += 1;
      } catch (error) {
        console.error("Failed to send notification websocket event:", error);
        sockets.delete(socketId);
      }
    }

    if (sockets.size === 0) this.socketsByUserId.delete(userId);
    return sent;
  }
}

export const notificationSockets = new NotificationSocketHub();
