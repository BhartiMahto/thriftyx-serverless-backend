const twilio = require('twilio');

const accountSid = 'AC7c8d13036d9dbc79c98bae643f37ca83';
const authToken = 'cae2cfae739c2b5a70eb5398a1b0663e';

const client = twilio(accountSid, authToken);

const sendWhatsapp = async (phone, message) => {
  try {
    const messageInstance = await client.messages.create({
      contentSid: 'HX1fc52a39da832912c836d710b7261d23',
      messagingServiceSid: "MG2cf4130acb3803d86817286de4b4519f",
      contentVariables: JSON.stringify({ 1: message }),
      to: `whatsapp:+91${phone}`
    });

    console.log(`WhatsApp message sent to ${phone}: SID ${messageInstance.sid}`);
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${phone}:`, error.message);
    console.error(error);
    throw error;
  }
};

const sendSMS = async (phone, message) => {
  try {
    const response = await client.messages.create({
      body: message,
      from: fromPhone,
      to: phone,
    });

    console.log(`SMS sent to ${phone}: SID ${response.sid}`);
  } catch (error) {
    console.error(`Failed to send SMS to ${phone}:, error.message`);
  }
};


module.exports = {sendWhatsapp, sendSMS};
