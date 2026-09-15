#include <Arduino.h>

// HC-SR04 wiring:
// VCC  -> 5V
// GND  -> GND
// TRIG -> GPIO 18
// ECHO -> 1k resistor -> GPIO 19
// GPIO 19 -> 2k resistor -> GND
// Do not connect the sensor's 5V ECHO directly to GPIO 19.

const int trigPin = 18;
const int echoPin = 19;
const unsigned long serialBaudRate = 115200; // Match sensorZoomSettings in main.js.
const unsigned long measurementIntervalMs = 100;
const unsigned long echoTimeoutUs = 30000;
const float minimumDistanceCm = 2.0f;
const float maximumDistanceCm = 400.0f;

unsigned long lastMeasurement = 0;

void sendDistance() {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  const unsigned long duration = pulseIn(echoPin, HIGH, echoTimeoutUs);
  const float distanceCm = duration / 58.0f;
  const bool valid = duration > 0
    && distanceCm >= minimumDistanceCm
    && distanceCm <= maximumDistanceCm;

  // One JSON object per line; invalid echoes never become a zero-distance zoom.
  Serial.print("{\"valid\":");
  Serial.print(valid ? "true" : "false");
  Serial.print(",\"cm\":");
  if (valid) {
    Serial.print(distanceCm, 1);
  } else {
    Serial.print("null");
  }
  Serial.println("}");
}

void setup() {
  Serial.begin(serialBaudRate);
  pinMode(trigPin, OUTPUT);
  digitalWrite(trigPin, LOW);
  pinMode(echoPin, INPUT);
}

void loop() {
  const unsigned long now = millis();
  if (now - lastMeasurement >= measurementIntervalMs) {
    lastMeasurement = now;
    sendDistance();
  }
  delay(2);
}
