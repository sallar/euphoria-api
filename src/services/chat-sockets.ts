import type { ChatServerEvent } from "@/models/chat";

type ChatSocket = {
  id: string;
  userId: string;
  profileId: string;
  send: (event: ChatServerEvent) => unknown;
};

class ChatSocketHub {
  private readonly socketsById = new Map<string, ChatSocket>();
  private readonly socketsByProfileId = new Map<string, Map<string, ChatSocket>>();
  private readonly conversationSubscriptions = new Map<string, Set<string>>();
  private readonly subscriptionsBySocketId = new Map<string, Set<string>>();

  add(socket: ChatSocket) {
    this.socketsById.set(socket.id, socket);

    const sockets = this.socketsByProfileId.get(socket.profileId) ?? new Map<string, ChatSocket>();
    const wasFirstProfileSocket = sockets.size === 0;

    sockets.set(socket.id, socket);
    this.socketsByProfileId.set(socket.profileId, sockets);

    return { wasFirstProfileSocket };
  }

  remove(socketId: string) {
    const socket = this.socketsById.get(socketId);
    if (!socket) return null;

    this.socketsById.delete(socketId);

    const sockets = this.socketsByProfileId.get(socket.profileId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) this.socketsByProfileId.delete(socket.profileId);
    }

    const subscriptions = this.subscriptionsBySocketId.get(socketId) ?? new Set<string>();
    for (const conversationId of subscriptions) {
      const conversationSockets = this.conversationSubscriptions.get(conversationId);
      conversationSockets?.delete(socketId);
      if (conversationSockets?.size === 0) this.conversationSubscriptions.delete(conversationId);
    }
    this.subscriptionsBySocketId.delete(socketId);

    return {
      profileId: socket.profileId,
      wasLastProfileSocket: !this.socketsByProfileId.has(socket.profileId),
    };
  }

  subscribe(socketId: string, conversationId: string) {
    const socket = this.socketsById.get(socketId);
    if (!socket) return false;

    const socketSubscriptions = this.subscriptionsBySocketId.get(socketId) ?? new Set<string>();
    socketSubscriptions.add(conversationId);
    this.subscriptionsBySocketId.set(socketId, socketSubscriptions);

    const conversationSockets =
      this.conversationSubscriptions.get(conversationId) ?? new Set<string>();
    conversationSockets.add(socketId);
    this.conversationSubscriptions.set(conversationId, conversationSockets);

    return true;
  }

  unsubscribe(socketId: string, conversationId: string) {
    const socketSubscriptions = this.subscriptionsBySocketId.get(socketId);
    socketSubscriptions?.delete(conversationId);
    if (socketSubscriptions?.size === 0) this.subscriptionsBySocketId.delete(socketId);

    const conversationSockets = this.conversationSubscriptions.get(conversationId);
    conversationSockets?.delete(socketId);
    if (conversationSockets?.size === 0) this.conversationSubscriptions.delete(conversationId);
  }

  isSocketSubscribed(socketId: string, conversationId: string) {
    return this.subscriptionsBySocketId.get(socketId)?.has(conversationId) ?? false;
  }

  isProfileOnline(profileId: string) {
    return this.socketsByProfileId.has(profileId);
  }

  getActiveUserIdsForProfile(profileId: string) {
    const sockets = this.socketsByProfileId.get(profileId);
    if (!sockets) return new Set<string>();

    return new Set(Array.from(sockets.values()).map(({ userId }) => userId));
  }

  getActiveUserIdsForConversationSubscribers(conversationId: string) {
    const socketIds = this.conversationSubscriptions.get(conversationId);
    if (!socketIds) return new Set<string>();

    const userIds = new Set<string>();
    for (const socketId of socketIds) {
      const socket = this.socketsById.get(socketId);
      if (socket) userIds.add(socket.userId);
    }

    return userIds;
  }

  sendToProfile(
    profileId: string,
    event: ChatServerEvent,
    options: { excludeSocketId?: string } = {},
  ) {
    const sockets = this.socketsByProfileId.get(profileId);
    if (!sockets) return 0;

    return this.sendToSockets(sockets.keys(), event, options);
  }

  sendToProfiles(profileIds: Iterable<string>, event: ChatServerEvent) {
    let sent = 0;
    for (const profileId of profileIds) {
      sent += this.sendToProfile(profileId, event);
    }

    return sent;
  }

  sendToConversationSubscribers(
    conversationId: string,
    event: ChatServerEvent,
    options: { excludeSocketId?: string } = {},
  ) {
    const socketIds = this.conversationSubscriptions.get(conversationId);
    if (!socketIds) return 0;

    return this.sendToSockets(socketIds, event, options);
  }

  private sendToSockets(
    socketIds: Iterable<string>,
    event: ChatServerEvent,
    options: { excludeSocketId?: string },
  ) {
    let sent = 0;
    const staleSocketIds: string[] = [];

    for (const socketId of socketIds) {
      if (socketId === options.excludeSocketId) continue;

      const socket = this.socketsById.get(socketId);
      if (!socket) {
        staleSocketIds.push(socketId);
        continue;
      }

      try {
        socket.send(event);
        sent += 1;
      } catch (error) {
        console.error("Failed to send chat websocket event:", error);
        staleSocketIds.push(socketId);
      }
    }

    for (const socketId of staleSocketIds) {
      this.remove(socketId);
    }

    return sent;
  }
}

export const chatSockets = new ChatSocketHub();
