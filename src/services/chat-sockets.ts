import type { ChatSocketEvent } from "@/models/chat";

type ChatSocket = {
  id: string;
  userId: string;
  profileId: string;
  send: (event: ChatSocketEvent) => unknown;
};

class ChatSocketHub {
  private readonly socketsByConversationId = new Map<string, Map<string, ChatSocket>>();

  add(conversationId: string, socket: ChatSocket) {
    const sockets =
      this.socketsByConversationId.get(conversationId) ?? new Map<string, ChatSocket>();
    sockets.set(socket.id, socket);
    this.socketsByConversationId.set(conversationId, sockets);
  }

  remove(conversationId: string, socketId: string) {
    const sockets = this.socketsByConversationId.get(conversationId);
    if (!sockets) return;

    sockets.delete(socketId);
    if (sockets.size === 0) this.socketsByConversationId.delete(conversationId);
  }

  getActiveUserIds(conversationId: string) {
    const sockets = this.socketsByConversationId.get(conversationId);
    if (!sockets) return new Set<string>();

    return new Set(Array.from(sockets.values()).map(({ userId }) => userId));
  }

  isProfileInConversation(conversationId: string, profileId: string) {
    const sockets = this.socketsByConversationId.get(conversationId);
    if (!sockets) return false;

    return Array.from(sockets.values()).some((socket) => socket.profileId === profileId);
  }

  sendToConversation(
    conversationId: string,
    event: ChatSocketEvent,
    options: { excludeSocketId?: string } = {},
  ) {
    const sockets = this.socketsByConversationId.get(conversationId);
    if (!sockets) return 0;

    let sent = 0;
    for (const [socketId, socket] of sockets) {
      if (socketId === options.excludeSocketId) continue;

      try {
        socket.send(event);
        sent += 1;
      } catch (error) {
        console.error("Failed to send chat websocket event:", error);
        sockets.delete(socketId);
      }
    }

    if (sockets.size === 0) this.socketsByConversationId.delete(conversationId);
    return sent;
  }
}

export const chatSockets = new ChatSocketHub();
