import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { KeyRound, Plus, Trash2, ShieldCheck, Shield } from "lucide-react";
import {
  listUsers,
  createUser,
  setUserActive,
  setUserRole,
  resetUserPassword,
  deleteUser,
  getMyRole,
} from "@/lib/users.functions";

export const Route = createFileRoute("/_authenticated/usuarios")({
  beforeLoad: async () => {
    const { isAdmin } = await getMyRole();
    if (!isAdmin) throw redirect({ to: "/dashboard" });
  },
  head: () => ({ meta: [{ title: "Usuários — ConnectHub" }, { name: "robots", content: "noindex" }] }),
  component: UsersPage,
});

function UsersPage() {
  const qc = useQueryClient();
  const list = useServerFn(listUsers);
  const create = useServerFn(createUser);
  const setActive = useServerFn(setUserActive);
  const setRole = useServerFn(setUserRole);
  const resetPw = useServerFn(resetUserPassword);
  const del = useServerFn(deleteUser);

  const { data: users, isLoading } = useQuery({ queryKey: ["users"], queryFn: () => list() });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

  const [open, setOpen] = useState(false);
  const [pwUser, setPwUser] = useState<string | null>(null);

  const mCreate = useMutation({
    mutationFn: (data: any) => create({ data }),
    onSuccess: () => { toast.success("Usuário criado"); setOpen(false); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const mActive = useMutation({
    mutationFn: (data: any) => setActive({ data }),
    onSuccess: () => { toast.success("Status atualizado"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const mRole = useMutation({
    mutationFn: (data: any) => setRole({ data }),
    onSuccess: () => { toast.success("Permissão atualizada"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const mDelete = useMutation({
    mutationFn: (data: any) => del({ data }),
    onSuccess: () => { toast.success("Usuário removido"); invalidate(); },
    onError: (e: any) => toast.error(e.message),
  });
  const mReset = useMutation({
    mutationFn: (data: any) => resetPw({ data }),
    onSuccess: () => { toast.success("Senha redefinida"); setPwUser(null); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Usuários</h1>
          <p className="text-sm text-muted-foreground">Apenas você (admin mestre) pode criar, ativar ou remover contas.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" />Novo usuário</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Criar novo usuário</DialogTitle></DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                mCreate.mutate({
                  email: String(fd.get("email")),
                  password: String(fd.get("password")),
                  full_name: String(fd.get("full_name")),
                  role: String(fd.get("role")) as "admin" | "user",
                });
              }}
              className="space-y-3"
            >
              <div><Label>Nome completo</Label><Input name="full_name" required minLength={2} /></div>
              <div><Label>Email</Label><Input name="email" type="email" required /></div>
              <div><Label>Senha inicial (mín. 8)</Label><Input name="password" type="password" required minLength={8} /></div>
              <div>
                <Label>Permissão</Label>
                <Select name="role" defaultValue="user">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Usuário</SelectItem>
                    <SelectItem value="admin">Administrador</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="submit" disabled={mCreate.isPending}>
                  {mCreate.isPending ? "Criando..." : "Criar"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle>Contas cadastradas</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Permissão</TableHead>
                  <TableHead>Ativo</TableHead>
                  <TableHead>Último acesso</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users ?? []).map((u) => {
                  const isAdmin = u.roles.includes("admin");
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.full_name || "—"}</TableCell>
                      <TableCell>{u.email}</TableCell>
                      <TableCell>
                        <Badge
                          variant={isAdmin ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() =>
                            mRole.mutate({ user_id: u.id, role: isAdmin ? "user" : "admin" })
                          }
                        >
                          {isAdmin ? <><ShieldCheck className="h-3 w-3 mr-1" />Admin</> : <><Shield className="h-3 w-3 mr-1" />Usuário</>}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={u.is_active}
                          onCheckedChange={(v) => mActive.mutate({ user_id: u.id, is_active: v })}
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("pt-BR") : "Nunca"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => setPwUser(u.id)} title="Redefinir senha">
                          <KeyRound className="h-4 w-4" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" title="Excluir"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Excluir {u.email}?</AlertDialogTitle>
                              <AlertDialogDescription>Esta ação é permanente e apaga todos os dados do usuário.</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction onClick={() => mDelete.mutate({ user_id: u.id })}>Excluir</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!pwUser} onOpenChange={(v) => !v && setPwUser(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Redefinir senha</DialogTitle></DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              mReset.mutate({ user_id: pwUser!, password: String(fd.get("password")) });
            }}
            className="space-y-3"
          >
            <div><Label>Nova senha (mín. 8)</Label><Input name="password" type="password" required minLength={8} /></div>
            <DialogFooter>
              <Button type="submit" disabled={mReset.isPending}>
                {mReset.isPending ? "Salvando..." : "Salvar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
