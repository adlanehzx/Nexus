-- Jeu d'essai du scénario de réinstallation.
--
-- Identifiants fixes : la vérification d'après restauration les cite, et des
-- UUID aléatoires obligeraient à les faire voyager entre les deux phases.
INSERT INTO users (id, email, "displayName", role, status, "createdAt", "updatedAt")
VALUES ('11111111-1111-7111-8111-111111111111', 'scenario@exemple.test',
        'Scénario machine vide', 'ADMIN', 'ACTIVE', now(), now());

INSERT INTO conversations (id, "userId", title, status, "createdAt", "updatedAt")
VALUES ('22222222-2222-7222-8222-222222222222',
        '11111111-1111-7111-8111-111111111111',
        'Conversation à retrouver', 'ACTIVE', now(), now());

INSERT INTO messages (id, "conversationId", role, content, "contentText", "createdAt")
VALUES ('33333333-3333-7333-8333-333333333333',
        '22222222-2222-7222-8222-222222222222', 'USER',
        '[{"type":"text","text":"Range mes mails"}]', 'Range mes mails', now()),
       ('44444444-4444-7444-8444-444444444444',
        '22222222-2222-7222-8222-222222222222', 'ASSISTANT',
        '[{"type":"text","text":"C''est fait."}]', 'C''est fait.', now());
