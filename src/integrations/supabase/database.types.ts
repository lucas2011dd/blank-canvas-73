export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Table<R, I = Partial<R>, U = Partial<R>> = { Row: R; Insert: I; Update: U; Relationships: [] };

type Profile = { id: string; email: string; full_name: string | null; avatar_url: string | null; timezone: string | null; locale: string | null; theme: string | null; created_at: string; updated_at: string };
type UserRole = { id: string; user_id: string; role: "admin" | "user"; created_at: string };
type Connection = { id: string; user_id: string; name: string; description: string | null; provider: string; status: "online" | "offline" | "connecting" | "error"; qr_code: string | null; metadata: Json; last_sync_at: string | null; created_at: string; updated_at: string };
type Contact = { id: string; user_id: string; name: string; phone: string | null; email: string | null; company: string | null; city: string | null; notes: string | null; external_source: string | null; external_id: string | null; metadata: Json; created_at: string; updated_at: string };
type Tag = { id: string; user_id: string; name: string; color: string; created_at: string };
type ContactTag = { contact_id: string; tag_id: string };
type Conversation = { id: string; user_id: string; connection_id: string | null; contact_id: string | null; title: string | null; last_message_at: string; unread_count: number; created_at: string };
type Message = { id: string; conversation_id: string; user_id: string; direction: "inbound" | "outbound"; body: string | null; attachment_url: string | null; status: "sent" | "delivered" | "read" | "failed"; created_at: string };
type AuditLog = { id: string; user_id: string | null; action: string; entity: string | null; entity_id: string | null; metadata: Json; ip: string | null; user_agent: string | null; created_at: string };
type Integration = { id: string; user_id: string; provider: string; access_token: string | null; refresh_token: string | null; expires_at: string | null; scope: string | null; metadata: Json; created_at: string; updated_at: string };
type ApiKey = { id: string; user_id: string; name: string; key_hash: string; last_used_at: string | null; created_at: string; revoked_at: string | null };
type Webhook = { id: string; user_id: string; url: string; events: string[]; secret: string | null; active: boolean; created_at: string };

export interface Database {
  public: {
    Tables: {
      profiles: Table<Profile, Partial<Profile> & { id: string; email: string }>;
      user_roles: Table<UserRole, { user_id: string; role: "admin" | "user" }>;
      connections: Table<Connection, Partial<Connection> & { user_id: string; name: string }>;
      contacts: Table<Contact, Partial<Contact> & { user_id: string; name: string }>;
      tags: Table<Tag, { user_id: string; name: string; color?: string }>;
      contact_tags: Table<ContactTag, ContactTag>;
      conversations: Table<Conversation, Partial<Conversation> & { user_id: string }>;
      messages: Table<Message, Partial<Message> & { conversation_id: string; user_id: string; direction: "inbound" | "outbound" }>;
      audit_logs: Table<AuditLog, Partial<AuditLog> & { action: string }>;
      integrations: Table<Integration, Partial<Integration> & { user_id: string; provider: string }>;
      api_keys: Table<ApiKey, { user_id: string; name: string; key_hash: string }>;
      webhooks: Table<Webhook, { user_id: string; url: string; events?: string[]; secret?: string | null; active?: boolean }>;
    };
    Views: Record<string, never>;
    Functions: { has_role: { Args: { _user_id: string; _role: "admin" | "user" }; Returns: boolean } };
    Enums: { app_role: "admin" | "user" };
    CompositeTypes: Record<string, never>;
  };
}
