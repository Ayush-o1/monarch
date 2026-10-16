ALTER TABLE users
  ADD CONSTRAINT users_name_length_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  ADD CONSTRAINT users_email_length_check CHECK (char_length(email) BETWEEN 3 AND 255);
