import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { topic, difficulty, ukmla_domain, count = 1 } = req.body;

    // Initialize Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Get access token for Vertex AI
    const accessToken = await getVertexAIAccessToken();

    // Vertex AI prompt
    const prompt = `Generate ${count} UKMLA SAQ question(s) for:
Topic: ${topic}
Difficulty: ${difficulty}
UKMLA Domain: ${ukmla_domain}

Requirements:
- Clinical scenario-based question
- 3-5 mark question structure
- Clear marking criteria with specific points
- Realistic patient presentation
- UK medical practice context

Return JSON array format:
[{
  "question": "Clinical scenario and question text",
  "model_answer": "Comprehensive model answer",
  "marking_criteria": ["1 mark: specific point", "1 mark: another point"],
  "keywords": ["keyword1", "keyword2"],
  "total_marks": 5
}]`;

    // Call Vertex AI
    const response = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/locations/us-central1/publishers/google/models/gemini-1.5-pro:generateContent`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: prompt }]
          }]
        })
      }
    );

    const aiResult = await response.json();
    const generatedText = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      throw new Error('No content generated from AI');
    }

    // Parse AI response
    const questions = JSON.parse(generatedText.replace(/```json\n?|\n?```/g, ''));

    // Store in Supabase
    const questionsToInsert = questions.map(q => ({
      topic,
      difficulty,
      ukmla_domain,
      question_text: q.question,
      model_answer: q.model_answer,
      marking_criteria: q.marking_criteria,
      keywords: q.keywords,
      total_marks: q.total_marks,
    }));

    const { data, error } = await supabase
      .from('questions')
      .insert(questionsToInsert)
      .select();

    if (error) throw error;

    res.status(200).json({ success: true, questions: data });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
}

async function getVertexAIAccessToken() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000)
  };

  const token = jwt.sign(payload, serviceAccount.private_key, { algorithm: 'RS256' });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`
  });

  const result = await response.json();
  return result.access_token;
}
