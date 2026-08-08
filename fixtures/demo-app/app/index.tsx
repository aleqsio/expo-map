import { Link, router } from 'expo-router';
import { Button, Text, View } from 'react-native';

export default function Home() {
  return (
    <View>
      <Text>Home</Text>
      <Link href="/about">About</Link>
      <Link href="/details/42">Details of item 42</Link>
      <Button title="Open tabs" onPress={() => router.push('/(tabs)/home')} />
      <Button title="Open modal" onPress={() => router.push('/modal')} />
    </View>
  );
}
