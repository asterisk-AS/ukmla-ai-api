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
    const { question_id, user_answer, session_id } = req.body;

    // Initialize Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Get question details
    const { data: question, error: questionError } = await supabase
      .from('questions')
      .select('*')
      .eq('id', question_id)
      .single();

    if (questionError) throw questionError;

    // Get access token for Vertex AI
    const accessToken = await getVertexAIAccessToken();

    // Evaluation prompt
    const prompt = `Evaluate this UKMLA SAQ answer:

Question: ${question.question_text}
Model Answer: ${question.model_answer}
Student Answer: ${user_answer}
Marking Criteria: ${question.marking_criteria.join(', ')}
Total Marks: ${question.total_marks}

Provide detailed feedback in JSON format:
{
  "score": 3,
  "feedback": "Detailed feedback on what was correct/incorrect",
  "missing_points": ["What key points were missed"],
  "strengths": ["What the student did well"],
  "improvements": ["Specific suggestions for improvement"]
}`;

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
    const evaluationText = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!evaluationText) {
      throw new Error('No evaluation generated from AI');
    }

    // Parse AI response
    const evaluation = JSON.parse(evaluationText.replace(/```json\n?|\n?```/g, ''));

    // Store evaluation in database
    const { data, error } = await supabase
      .from('user_answers')
      .insert({
        session_id,
        question_id,
        user_answer,
        ai_feedback: evaluation,
        score: evaluation.score,
      })
      .select();

    if (error) throw error;

    res.status(200).json({ success: true, evaluation, answer_record: data[0] });

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
