-- Rode no Supabase → SQL Editor (seguro rodar mais de uma vez).

-- Modo Aula: guarda quando a aula foi encerrada
alter table public.aulas_ativas add column if not exists encerrada_em timestamptz;

-- Professor pode encerrar a própria aula
drop policy if exists "aulas_update_own" on public.aulas_ativas;
create policy "aulas_update_own" on public.aulas_ativas
  for update using (auth.uid() = professor_id) with check (auth.uid() = professor_id);

-- Aluno atualiza o próprio resultado de quiz
drop policy if exists "quiz_history_update_own" on public.quiz_history;
create policy "quiz_history_update_own" on public.quiz_history
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Aluno atualiza o próprio histórico de chat
drop policy if exists "chat_history_update_own" on public.chat_history;
create policy "chat_history_update_own" on public.chat_history
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Aluno lê as atividades/quizzes da própria série e turma (professor lê as suas)
drop policy if exists "atividades_read_turma" on public.atividades;
create policy "atividades_read_turma" on public.atividades
  for select using (
    professor_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.serie = atividades.serie and u.turma = atividades.turma
    )
  );
