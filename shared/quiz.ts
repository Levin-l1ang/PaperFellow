import { z } from 'zod';

const question = z.object({
  prompt: z.string().trim().min(8).max(600),
  choices: z.tuple([z.string().trim().min(1).max(360), z.string().trim().min(1).max(360),
    z.string().trim().min(1).max(360), z.string().trim().min(1).max(360)]),
  correct: z.number().int().min(0).max(3),
  explanation: z.string().trim().min(12).max(1200),
  evidence: z.array(z.string().regex(/^p\d+$/)).min(1).max(4),
}).strict().refine((item) => new Set(item.choices).size === 4, { message: '选项应彼此不同。' });

export const quizSchema = z.array(question).length(3);
export const answerSchema = z.object({ item: z.number().int().min(0).max(2), choice: z.number().int().min(0).max(3) }).strict();

export interface StoredQuiz {
  items: z.infer<typeof quizSchema>;
  answers: Record<number, number>;
  created: number;
}

export function visibleQuiz(quiz: StoredQuiz) {
  return {
    created: quiz.created,
    items: quiz.items.map(({ prompt, choices, correct, explanation, evidence }, index) => {
      const selected = quiz.answers[index];
      return selected === undefined ? { prompt, choices, result: null } : { prompt, choices, result: { selected, correct, explanation, evidence } };
    }),
  };
}

export type Quiz = ReturnType<typeof visibleQuiz>;
