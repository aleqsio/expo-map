import { Link } from 'expo-router';
import { useState } from 'react';
import { Button, Modal, Text, View } from 'react-native';

export default function TabHome() {
  const [visible, setVisible] = useState(false);
  return (
    <View>
      <Text>Tab home</Text>
      <Link href="/about">About</Link>
      <Link href={{ pathname: '/details/[id]', params: { id: '7' } }}>Item 7</Link>
      <Button title="Show modal" onPress={() => setVisible(true)} />
      <Modal visible={visible} transparent animationType="slide">
        <Text>In-screen modal</Text>
        <Button title="Close" onPress={() => setVisible(false)} />
      </Modal>
    </View>
  );
}
