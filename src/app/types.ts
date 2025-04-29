export interface EncryptedMessage {
    from: string;
    ciphertext: string;
    nonce: string;
};

export interface Contact {
    username: string;
    avatar: string;
    preview: string;
    time: string;
};

export type Message = {
    from: string;
    to: string;
    text: string;
    image?: string;
};