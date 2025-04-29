"use client";

import { useState, useEffect, useRef } from "react";
import { EncryptedMessage, Contact, Message } from "./types";
import api from "./axios";
import { io, Socket } from "socket.io-client";
import sodium from "libsodium-wrappers-sumo";

let socket: Socket;

export default function Home() {
  const [contacts, setContacts] = useState<(Contact & { hasUnread?: boolean })[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [input, setInput] = useState('');
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const currentUserRef = useRef<string | null>(null);
  const [usernameInput, setUsernameInput] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sentMessagesCache = useRef<Map<string, string>>(new Map());

  // Initialize public/private keys, sentMessage cache, setting user-specific states
  useEffect(() => {
    sodium.ready.then(async () => {
      const existingPrivate = localStorage.getItem('privateKey');
      const existingPublic = localStorage.getItem('publicKey');
      const existingUser = localStorage.getItem('currentUser');

      if (!existingPrivate || !existingPublic) {
        const keyPair = sodium.crypto_box_keypair();
        localStorage.setItem('privateKey', sodium.to_base64(keyPair.privateKey));
        localStorage.setItem('publicKey', sodium.to_base64(keyPair.publicKey));
      }
      const cachedSent = localStorage.getItem('sentMessagesCache');
      if (cachedSent) {
        sentMessagesCache.current = new Map(JSON.parse(cachedSent));
      }

      if (existingUser) {
        setCurrentUser(existingUser);
        setIsLoggedIn(true);
        await initializeUser(existingUser);
      }
    });
  }, []);

  // Ensures consistent currentUser state
  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  // Fetches messages if user state changes
  useEffect(() => {
    if (selectedContact && currentUser) fetchMessages();
  }, [selectedContact, currentUser]);

  // Assigns jwt token to new user
  async function initializeUser(username: string) {
    const publicKey = localStorage.getItem('publicKey');
    let token = localStorage.getItem('jwt');

    if (!token) {
      const res = await api.post('/api/auth', { username, publicKey });
      token = res.data.token;
      localStorage.setItem('jwt', token);
      await api.post('/api/publickeys', { publicKey });
    }

    const res = await api.get('/api/contacts');
    setContacts(res.data);

    socket = io('http://localhost:4000', { auth: { token } });
    socket.on('message:receive', handleReceive);
  }

  // Fetches and decrypts messages
  async function fetchMessages() {
    if (!selectedContact || !currentUser) return;
    const res = await api.get(`/api/messages?with=${selectedContact.username}`);
    const myPrivateKey = sodium.from_base64(localStorage.getItem('privateKey')!);

    const decryptedMessages = await Promise.all(res.data.map(async (msg: any) => {
      if (msg.to === currentUser) {
        const senderPublicKey = sodium.from_base64(await getOrFetchPublicKey(msg.from));
        const decrypted = sodium.crypto_box_open_easy(
          sodium.from_base64(msg.ciphertext),
          sodium.from_base64(msg.nonce),
          senderPublicKey,
          myPrivateKey
        );
        const text = sodium.to_string(decrypted);
        return { from: msg.from, to: msg.to, text, time: msg.created_at || new Date().toISOString() };
      } else {
        const cachedText = sentMessagesCache.current.get(msg.nonce) || "(sent message)";
        return { from: msg.from, to: msg.to, text: cachedText, time: msg.created_at || new Date().toISOString() };
      }
    }));

    setMessages(decryptedMessages);
  }

  // Handles websocket message receiving
  const handleReceive = async (msg: EncryptedMessage) => {
    const myPrivateKey = sodium.from_base64(localStorage.getItem('privateKey')!);
    const senderPublicKey = sodium.from_base64(await getOrFetchPublicKey(msg.from));
    const decrypted = sodium.crypto_box_open_easy(
      sodium.from_base64(msg.ciphertext),
      sodium.from_base64(msg.nonce),
      senderPublicKey,
      myPrivateKey
    );
    const text = sodium.to_string(decrypted);

    const newMessage: Message = { from: msg.from, to: currentUserRef.current!, text, time: new Date().toISOString() };
    setMessages(prev => [...prev, newMessage]);

    if (selectedContact?.username !== msg.from) {
      setSelectedContact({ username: msg.from, avatar: '', preview: text, time: new Date().toISOString() });
      setContacts(prev => {
        const alreadyExists = prev.some(c => c.username === msg.from);
        if (!alreadyExists) {
          return [...prev, { username: msg.from, avatar: '', preview: text, time: new Date().toISOString(), hasUnread: true }];
        }
        return prev.map(c => 
          c.username === msg.from 
            ? { ...c, preview: text, time: new Date().toISOString(), hasUnread: true }
            : c
        );
      });
      await fetchMessages();
    } else {
      await fetchMessages();
    }
  };

  // Encrypts and sends message
  const sendMessage = async () => {
    if (!input.trim() || !selectedContact || !currentUser) return;

    const recipient = selectedContact.username;
    const myPrivateKey = sodium.from_base64(localStorage.getItem('privateKey')!);
    const recipientPublicKey = sodium.from_base64(await getOrFetchPublicKey(recipient));
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
    const encrypted = sodium.crypto_box_easy(sodium.from_string(input), nonce, recipientPublicKey, myPrivateKey);

    const payload = {
      to: recipient,
      ciphertext: sodium.to_base64(encrypted),
      nonce: sodium.to_base64(nonce),
    };

    sentMessagesCache.current.set(payload.nonce, input);
    localStorage.setItem('sentMessagesCache', JSON.stringify(Array.from(sentMessagesCache.current.entries())));

    socket.emit('message:send', payload);

    setMessages(prev => [...prev, { from: currentUser, to: recipient, text: input, time: new Date().toISOString() }]);
    setInput('');
    inputRef.current?.focus();
  };

  // Sets username-specific states in registration
  const handleUsernameSubmit = async () => {
    if (usernameInput.trim()) {
      localStorage.setItem('currentUser', usernameInput);
      setCurrentUser(usernameInput);
      setIsLoggedIn(true);
      await initializeUser(usernameInput);
    } else {
      alert('Username is required.');
    }
  };

  // Returns public key of conversation partner
  const getOrFetchPublicKey = async (username: string): Promise<string> => {
    const cached = localStorage.getItem(`pub:${username}`);
    if (cached) return cached;
    const res = await api.post('/api/getpublickey', { username });
    localStorage.setItem(`pub:${username}`, res.data.publicKey);
    return res.data.publicKey;
  };

  const selectContact = (contact: Contact) => {
    setSelectedContact(contact);
    setContacts(prev => prev.map(c => (c.username === contact.username ? { ...c, hasUnread: false } : c)));
  };

  return !isLoggedIn ? (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="bg-white p-6 shadow-lg rounded-lg space-y-4">
        <input
          className="border border-gray-300 rounded-md px-4 py-2 w-64"
          placeholder="Enter username..."
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUsernameSubmit()}
        />
        <button
          onClick={handleUsernameSubmit}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 rounded-md transition"
        >
          Login
        </button>
      </div>
    </div>
  ) : (
    <div className="flex h-screen text-sm bg-gray-100">
      <aside className="w-64 bg-white p-4 border-r flex flex-col">
        <h2 className="text-lg font-semibold mb-6">Conversations</h2>
        <div className="flex-1 overflow-y-auto">
          {contacts.length > 0 ? (
            <ul className="space-y-3">
              {contacts.map((contact, idx) => (
                <li
                  key={idx}
                  className={`flex items-center gap-2 p-2 rounded-md cursor-pointer hover:bg-purple-100 transition ${selectedContact?.username === contact.username ? 'bg-purple-100' : ''}`}
                  onClick={() => selectContact(contact)}
                >
                  <div className="w-8 h-8 bg-purple-300 text-white rounded-full flex items-center justify-center font-bold">
                    {(contact.username)[0]?.toUpperCase()}
                  </div>
                  <div className="flex flex-col overflow-hidden">
                    <span className="font-medium truncate">{contact.username}</span>
                    <span className="text-xs text-gray-500 truncate">{contact.preview || "No messages yet"}</span>
                  </div>
                  {contact.hasUnread && (
                    <span className="ml-auto w-2 h-2 bg-red-500 rounded-full"></span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-gray-400 text-center mt-10">No conversations yet</div>
          )}
        </div>
        <button
          className="mt-4 bg-purple-100 hover:bg-purple-200 p-2 rounded-md w-full text-purple-800 font-semibold transition"
          onClick={async () => {
            const newUser = prompt('Start conversation with username:');
            if (newUser) {
              await getOrFetchPublicKey(newUser);
              setSelectedContact({ username: newUser, avatar: '', preview: '', time: '' });
              setMessages([]);
            }
          }}
        >
          + New Conversation
        </button>
      </aside>

      <main className="flex-1 flex flex-col bg-gray-50">
        <header className="p-4 border-b bg-white shadow-sm font-semibold text-lg">
          {selectedContact ? selectedContact.username : "Select a conversation"}
        </header>
        <div className="flex-1 p-6 overflow-y-auto space-y-4">
          {messages.length > 0 ? (
            messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.from === currentUser ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-xs px-4 py-2 rounded-2xl ${msg.from === currentUser ? 'bg-purple-600 text-white' : 'bg-blue-300 text-black'}`}>
                  <div>{msg.text}</div>
                  {msg.time && (
                    <div className="text-[10px] mt-1 text-gray-200 text-right">
                      {new Date(msg.time).toLocaleTimeString()}
                    </div>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="text-gray-400 text-center mt-10">No messages yet</div>
          )}
        </div>
        <footer className="p-4 bg-white border-t flex items-center gap-2">
          <input
            ref={inputRef}
            className="flex-1 border rounded-full px-4 py-2"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />
          <button
            onClick={sendMessage}
            className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-2 rounded-full font-semibold transition"
          >
            Send
          </button>
        </footer>
      </main>
    </div>
  );
