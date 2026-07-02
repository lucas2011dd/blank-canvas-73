// Tipos manuais (não usa Lovable Cloud). Regenere com:
//   npx supabase gen types typescript --project-id $SUPABASE_PROJECT_ID > src/integrations/supabase/database.types.ts
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: { Row: { id: string; email: string; full_name: string | null; avatar_url: string | null; timezone: string | null; locale: string | null; theme: string | null; created_at: string; updated_at: string }; Insert: Partial<Database["public"]["Tables"]["profiles"]["Row"]> & { id: string; email: string }; Update: Partial<Database["public"]["Tables"]["profiles"]["Row"]> };
      user_roles: { Row: { id: string; user_id: string; role: "admin" | "user"; created_at: string }; Insert: { user_id: string; role: "admin" | "user" }; Update: Partial<{ role: "admin" | "user" }> };
      connections: { Row: { id: string; user_id: string; name: string; description: string | null; provider: string; status: "online" | "offline" | "connecting" | "error"; qr_code: string | null; metadata: Json; last_sync_at: string | null; created_at: string; updated_at: string }; Insert: Partial<Database["public"]["Tables"]["connections"]["Row"]> & { user_id: string; name: string }; Update: Partial<Database["public"]["Tables"]["connections"]["Row"]> };
      contacts: { Row: { id: string; user_id: string; name: string; phone: string | null; email: string | null; company: string | null; city: string | null; notes: string | null; external_source: string | null; external_id: string | null; metadata: Json; created_at: string; updated_at: string }; Insert: Partial<Database["public"]["Tables"]["contacts"]["Row"]> & { user_id: string; name: string }; Update: Partial<Database["public"]["Tables"]["contacts"]["Row"]> };
      tags: { Row: { id: string; user_id: string; name: string; color: string; created_at: string }; Insert: { user_id: string; name: string; color?: string }; Update: Partial<{ name: string; color: string }> };
      contact_tags: { Row: { contact_id: string; tag_id: string }; Insert: { contact_id: string; tag_id: string }; Update: never };
      conversations: { Row: { id: string; user_id: string; connection_id: string | null; contact_id: string | null; title: string | null; last_message_at: string; unread_count: number; created_at: string }; Insert: Partial<Database["public"]["Tables"]["conversations"]["Row"]> & { user_id: string }; Update: Partial<Database["public"]["Tables"]["conversations"]["Row"]> };
      messages: { Row: { id: string; conversation_id: string; user_id: string; direction: "inbound" | "outbound"; body: string | null; attachment_url: string | null; status: "sent" | "delivered" | "read" | "failed"; created_at: string }; Insert: Partial<Database["public"]["Tables"]["messages"]["Row"]> & { conversation_id: string; user_id: string; direction: "inbound" | "outbound" }; Update: Partial<Database["public"]["Tables"]["messages"]["Row"]> };
      audit_logs: { Row: { id: string; user_id: string | null; action: string; entity: string | null; entity_id: string | null; metadata: Json; ip: string | null; user_agent: string | null; created_at: string }; Insert: Partial<Database["public"]["Tables"]["audit_logs"]["Row"]> & { action: string }; Update: never };
      integrations: { Row: { id: string; user_id: string; provider: string; access_token: string | null; refresh_token: string | null; expires_at: string | null; scope: string | null; metadata: Json; created_at: string; updated_at: string }; Insert: Partial<Database["public"]["Tables"]["integrations"]["Row"]> & { user_id: string; provider: string }; Update: Partial<Database["public"]["Tables"]["integrations"]["Row"]> };
      api_keys: { Row: { id: string; user_id: string; name: string; key_hash: string; last_used_at: string | null; created_at: string; revoked_at: string | null }; Insert: { user_id: string; name: string; key_hash: string }; Update: Partial<{ revoked_at: string | null; last_used_at: string | null }> };
      webhooks: { Row: { id: string; user_id: string; url: string; events: string[]; secret: string | null; active: boolean; created_at: string }; Insert: { user_id: string; url: string; events?: string[]; secret?: string | null; active?: boolean }; Update: Partial<{ url: string; events: string[]; secret: string | null; active: boolean }> };
    };
    Views: Record<string, never>;
    Functions: { has_role: { Args: { _user_id: string; _role: "admin" | "user" }; Returns: boolean } };
    Enums: { app_role: "admin" | "user" };
  };
}
