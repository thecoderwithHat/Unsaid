"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';

type ChatMessage = {
  text: string;
  ts: number;
  sender?: string;
  senderId?: string;
};

const ChatWidget: React.FC = () => {
  const { data: session } = useSession();
  const user = session?.user;
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [channelName, setChannelName] = useState('');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [assignedCounsellor, setAssignedCounsellor] = useState<{ id: string; name?: string; email?: string } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const connectToRoom = useCallback((name: string) => {
    if (!name || typeof window === 'undefined') return;

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // no-op
      }
      wsRef.current = null;
    }

    setMessages([]);
    setIsSubscribed(false);
    setConnectionError(null);
    setChannelName(name);

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/api/socket?room=${encodeURIComponent(name)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsSubscribed(true);
    };

    ws.onerror = () => {
      setConnectionError('Unable to connect to chat. Please try again.');
      setIsSubscribed(false);
    };

    ws.onclose = (evt) => {
      setIsSubscribed(false);
      if (evt.code === 1008 && evt.reason) {
        setConnectionError(evt.reason);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Partial<ChatMessage>;
        if (typeof data.text !== 'string') return;
        const ts = typeof data.ts === 'number' ? data.ts : Date.now();
        setMessages((prev) => [...prev, { text: data.text!, ts, sender: data.sender, senderId: data.senderId }]);
      } catch {
        // ignore malformed messages
      }
    };
  }, []);

  // Fetch assigned counsellor on mount (for patients)
  useEffect(() => {
    if (!session || !user || user.role !== 'USER') return;

    const fetchAssignment = async () => {
      try {
        const res = await fetch('/api/assignments');
        if (res.ok) {
          const data = await res.json();
          if (data.assignment?.counsellor) {
            setAssignedCounsellor(data.assignment.counsellor);
          }
        }
      } catch {
        // ignore assignment failures
      }
    };

    fetchAssignment();
  }, [session, user]);

  // Activity heartbeat - update lastActive every 30 seconds
  useEffect(() => {
    if (!session || !user) return;

    const updateActivity = async () => {
      try {
        const res = await fetch('/api/activity', { method: 'POST' });
        if (!res.ok) {
          // no-op
        }
      } catch {
        // ignore heartbeat failures
      }
    };

    updateActivity();

    const interval = setInterval(updateActivity, 30 * 1000);
    return () => clearInterval(interval);
  }, [session, user]);

  useEffect(() => {
    if (session && user && open && !isSubscribed) {
      if (user.role === 'USER' && assignedCounsellor) {
        const privateChannel = `private-chat-${assignedCounsellor.id}-${user.id}`;
        connectToRoom(privateChannel);
      }
    }
  }, [session, user, open, isSubscribed, assignedCounsellor, connectToRoom]);

  // Listen for a global event to open the chat (used by counsellor/patient dashboards)
  useEffect(() => {
    if (!session || !user) return;

    const handler = async (ev: Event) => {
      setOpen(true);
      const anyEv = ev as CustomEvent<Record<string, string | undefined>>;
      const counsellorId = anyEv?.detail?.counsellorId;
      const patientId = anyEv?.detail?.patientId;

      try {
        if (user.role === 'COUNSELLOR' && patientId) {
          const name = `private-chat-${user.id}-${patientId}`;
          connectToRoom(name);
          return;
        }

        if (counsellorId) {
          const patientUid = user?.id;
          if (patientUid) {
            const name = `private-chat-${counsellorId}-${patientUid}`;
            connectToRoom(name);
            return;
          }
        }

        if (user.role === 'USER' && assignedCounsellor) {
          const name = `private-chat-${assignedCounsellor.id}-${user.id}`;
          connectToRoom(name);
          return;
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener('open-chat', handler as EventListener);
    return () => window.removeEventListener('open-chat', handler as EventListener);
  }, [user, session, assignedCounsellor, connectToRoom]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // no-op
        }
      }
    };
  }, []);

  const sendMessage = async () => {
    if (!input.trim()) return;
    const sender = user?.email ?? user?.id ?? 'Guest';
    const senderId = user?.id;
    const messageText = input;
    const timestamp = Date.now();

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setConnectionError('Chat is not connected.');
      return;
    }

    setMessages((m) => [...m, { text: messageText, ts: timestamp, sender, senderId }]);
    setInput('');

    try {
      ws.send(JSON.stringify({ text: messageText }));
    } catch {
      setConnectionError('Failed to send message.');
      setMessages((m) => m.filter((msg) => !(msg.text === messageText && msg.ts === timestamp)));
    }
  };

  const isOwnMessage = (sender?: string, senderId?: string) => {
    if (!sender && !senderId) return false;
    return senderId === user?.id || sender === user?.email || sender === user?.id;
  };

  if (!session || !user) {
    return null;
  }

  const shouldHideButton = user.role === 'COUNSELLOR' && pathname === '/connect';

  return (
    <>
      {/* Global styles for custom scrollbar */}
      <style jsx>{`
        /* Custom Scrollbar for WebKit browsers (Chrome, Edge, Safari) */
        .custom-scrollbar::-webkit-scrollbar {
          width: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: #f7f4f2;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #a1cdd9;
          border-radius: 10px;
          border: 2px solid #f7f4f2;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #7db7c7;
        }

        /* For Firefox */
        .custom-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: #a1cdd9 #f7f4f2;
        }
      `}</style>

      <div
        className={`fixed inset-0 bg-[#000000cd] bg-opacity-50 flex items-center justify-center z-50 transition-opacity duration-300 ease-in-out ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div
          className={`w-[500px] h-[600px] bg-[#F7F4F2] border-4 border-[#C6C3C2] rounded-3xl shadow-2xl flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${
            open ? "scale-100 opacity-100" : "scale-95 opacity-0"
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 pb-2">
            <div className="flex flex-col">
              <div className="text-2xl font-extrabold text-[#736B66] cursor-default">Live Chat</div>
              {user.role === 'USER' && assignedCounsellor && (
                <div className="text-sm text-gray-600">
                  With: {assignedCounsellor.name || assignedCounsellor.email}
                </div>
              )}
              {user.role === 'COUNSELLOR' && channelName.startsWith('private-') && (
                <div className="text-sm text-gray-600">Private conversation</div>
              )}
              {connectionError && (
                <div className="text-xs text-red-500">{connectionError}</div>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-3xl text-gray-500 hover:text-gray-700 leading-none w-8 h-8 flex items-center justify-center cursor-pointer"
            >
              &times;
            </button>
          </div>

          {/* Messages */}
          <div ref={messagesRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-4 custom-scrollbar">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${isOwnMessage(m.sender, m.senderId) ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[60%] px-6 py-3 rounded-xl ${
                    isOwnMessage(m.sender, m.senderId)
                      ? "bg-[#A1CDD9] text-white text-xl font-unsaid font-bold border border-[#F4A258]"
                      : "bg-white text-[#736B66] text-xl font-unsaid font-bold border border-[#F4A258]"
                  }`}
                >
                  <div className="text-base leading-relaxed">{m.text}</div>
                </div>
              </div>
            ))}
            {!channelName && (
              <div className="text-sm text-gray-500 text-center">Start a conversation with your assigned counsellor.</div>
            )}
          </div>

          {/* Input */}
          <div className="bg-[#FBFAF9] border-t border-[#C4B5A0] p-3 flex items-center justify-between">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="flex-1 bg-transparent text-[#736B66] font-semibold outline-none ml-3 text-xl placeholder-[#B9B5B3]"
              placeholder="Type your message..."
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
            />
            <button
              onClick={sendMessage}
              className="bg-[#F4A258] hover:bg-[#DC924F] text-xl text-white font-extrabold px-8 py-2 rounded-3xl cursor-pointer shadow-md transform active:shadow-none active:scale-95 transition-all duration-75 ease-out"
              disabled={!isSubscribed}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Toggle Button */}
      {!shouldHideButton && (
        <div className="fixed bottom-6 right-6 z-40">
          <button
            onClick={() => setOpen((s) => !s)}
            className="w-16 h-16 rounded-full bg-[#9DCDDC] hover:bg-[#8BBDCC] flex items-center justify-center shadow-xl text-2xl transition-all"
            aria-label="Toggle chat"
          >
            💬
          </button>
        </div>
      )}
    </>
  );
};

export default ChatWidget;
