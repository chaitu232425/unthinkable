import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from '@/lib/api';
import { useAuth } from './AuthContext';

/**
 * One shared Socket.IO connection.
 *
 * The socket is an accelerator, never the source of truth: components render from REST
 * data and use socket deltas only to patch it. `connected` is exposed so the UI can say
 * "live" or "reconnecting" honestly instead of pretending.
 */
interface SocketState {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketState>({ socket: null, connected: false });

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? window.location.origin;

export function SocketProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (loading) return undefined;

    // Reconnect when the identity changes so the private user room is correct.
    const instance = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      auth: { token: getAccessToken() },
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    instance.on('connect', () => setConnected(true));
    instance.on('disconnect', () => setConnected(false));

    setSocket(instance);
    return () => {
      instance.close();
      setSocket(null);
      setConnected(false);
    };
  }, [loading, user?.id]);

  const value = useMemo(() => ({ socket, connected }), [socket, connected]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketState {
  return useContext(SocketContext);
}
