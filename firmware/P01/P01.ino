// P01: LED·버튼·가변저항·CdS·DHT11·LCD를 동시에 연결하는 기본 통합 회로.
// 같은 폴더의 pins.h가 배선표와 동일한 핀을 지정합니다.
#include "pins.h"
#include <DHT.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>
#include "protocol.h"
DHT dht(PIN_DHT, DHT11);
hd44780_I2Cexp lcd;
bool ledOn=false, automatic=false, dhtValid=false, lcdReady=false;
float temperature=0, humidity=0;
int lightRaw=0, potRaw=0, onThreshold=350, offThreshold=450;
unsigned long lastDht=0, lastDisplay=0, lastState=0;
void safeStop() { automatic=false; ledOn=false; digitalWrite(PIN_LED, LOW); }
void snapshot(unsigned int request) {
  stateStart(request);
  Serial.print(F(",\"pot_raw\":")); Serial.print(potRaw);
  Serial.print(F(",\"light_raw\":")); Serial.print(lightRaw);
  Serial.print(F(",\"button_pressed\":")); Serial.print(digitalRead(PIN_BUTTON)==LOW ? F("true") : F("false"));
  Serial.print(F(",\"led\":")); Serial.print(ledOn?1:0);
  Serial.print(F(",\"auto\":")); Serial.print(automatic?F("true"):F("false"));
  Serial.print(F(",\"lcd_ready\":")); Serial.print(lcdReady?F("true"):F("false"));
  Serial.print(F(",\"temperature_c\":")); if(dhtValid) Serial.print(temperature,1); else Serial.print(F("null"));
  Serial.print(F(",\"humidity_pct\":")); if(dhtValid) Serial.print(humidity,1); else Serial.print(F("null"));
  Serial.println('}');
}
bool command(unsigned int request, const char *name, char *args) {
  long value;
  if (!strcmp(name,"LED") && integer(args,0,1,value)) {
    automatic=false; ledOn=value; digitalWrite(PIN_LED,ledOn?HIGH:LOW); applied(request); return true;
  }
  if (!strcmp(name,"AUTO") && integer(args,0,1,value)) { automatic=value; applied(request); return true; }
  if (!strcmp(name,"THRESH")) {
    long limits[2];
    if(integers(args,2,0,1023,limits) && limits[0]<limits[1]) {
      onThreshold=limits[0]; offThreshold=limits[1]; applied(request); return true;
    }
  }
  errorReply(request,F("unsupported_or_range")); return false;
}
void setup() {
  pinMode(PIN_LED,OUTPUT); pinMode(PIN_BUTTON,INPUT_PULLUP); safeStop();
  Serial.begin(115200); dht.begin();
  Wire.begin(); Wire.setWireTimeout(25000,true);
  lcdReady=lcd.begin(16,2)==0;
  if(lcdReady) { lcd.backlight(); lcd.print("P01 ready"); }
  lastContact=millis();
}
void loop() {
  readCommands(); unsigned long now=millis();
  potRaw=analogRead(PIN_POT); lightRaw=analogRead(PIN_LIGHT);
  // CdS를 5V 쪽, 10k 저항을 GND 쪽에 둔 회로: 어두울수록 값이 작습니다.
  if(automatic) {
    if(lightRaw<onThreshold) ledOn=true;
    else if(lightRaw>offThreshold) ledOn=false;
    digitalWrite(PIN_LED,ledOn?HIGH:LOW);
  }
  if(now-lastDht>=2000) {
    lastDht=now; humidity=dht.readHumidity(); temperature=dht.readTemperature();
    dhtValid=!isnan(humidity)&&!isnan(temperature);
  }
  if(lcdReady && now-lastDisplay>=500) {
    lastDisplay=now; char row[17]; snprintf(row,sizeof(row),"Light:%4d L:%d ",lightRaw,ledOn);
    lcd.setCursor(0,1); lcd.print(row);
  }
  if(now-lastState>=1000) {lastState=now; snapshot(0);}
}
