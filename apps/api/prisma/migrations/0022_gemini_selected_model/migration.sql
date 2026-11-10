ALTER TABLE "AISharingPolicy" DROP CONSTRAINT provider_model_pair;
ALTER TABLE "AISharingPolicy" ADD CONSTRAINT provider_model_pair CHECK(("providerId"='openai' AND "modelId"='gpt-5.4-mini-2026-03-17') OR ("providerId"='gemini' AND "modelId" IN('gemini-2.5-flash','gemini-3.5-flash-lite')));
